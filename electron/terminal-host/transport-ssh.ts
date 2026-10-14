/**
 * SshTransport — reaches a terminal-host daemon on another machine over ssh.
 *
 * herdr's `SshStdioBridge`, minus the local unix socket: each logical
 * connection is one `ssh -T <target> 'exec manor-host remote-bridge'` child,
 * and since both ends live in this process the child's stdio is handed to the
 * client directly as a `Duplex`. The far end (`bridge.ts`) makes sure a
 * daemon is running there, writes one `bridgeHello` line carrying the auth
 * token, then pumps bytes to the daemon's socket. We strip that line and the
 * client never learns it is not talking to a local socket.
 *
 * Both connections share one TCP session through a ControlMaster socket kept
 * in a Manor-owned throwaway ssh config directory.
 *
 * The child plumbing (spawning, hello reading, exit errors) is the shared
 * `BridgeSpawner` (ADR-229 D3); this file supplies the `ssh -T -F <cfg>
 * <target> <cmd>` argv, the ControlMaster, and ssh's own failure wording.
 */

import type { Duplex } from "node:stream";
import type { HostTransport } from "./transport";
import { parseHello } from "./types";
import {
  BridgeSpawner,
  defaultBridgeSpawn,
  parseServerHello,
  type BridgeChildProcess,
  type BridgeSpawn,
  type EnsureRemoteHost,
  type RemoteExecOptions,
  type RemoteExecResult,
} from "./bridge-spawner";
import {
  SshAuthError,
  SshHostKeyError,
  assertValidTarget,
  buildControlArgs,
  buildResolveConfigArgs,
  buildSshArgs,
  createManagedSshConfig,
  isHostKeyError,
  isRemoteAuthError,
  parseControlPath,
  remoteBridgeCommand,
  remoteRestartCommand,
  remoteServerBridgeCommand,
  removeManagedSshConfig,
  type ManagedSshConfig,
} from "./ssh-config";

// The bridge plumbing moved to `bridge-spawner.ts` (ADR-229 D3); these names
// stay importable from here for the ssh-side callers that already use them.
export {
  awaitHelloLine,
  parseServerHello,
  type EnsureRemoteHost,
  type RemoteExec,
  type RemoteExecOptions,
  type RemoteExecResult,
} from "./bridge-spawner";

/** The slice of `ChildProcess` this transport uses. Narrow so tests can fake it. */
export type SshChild = BridgeChildProcess;

export type SshSpawn = BridgeSpawn;

export interface SshTransportOptions {
  /** Defaults to `child_process.spawn` with piped stdio. */
  spawn?: SshSpawn;
  /** Defaults to a stub that assumes the host binary is already installed. */
  ensureRemoteHost?: EnsureRemoteHost;
  /**
   * How long to wait for the `bridgeHello` line, and for the client's auth
   * and handshake replies. Cold TCP + key exchange + auth all happen inside
   * this window, hence far longer than the local default.
   */
  handshakeTimeoutMs?: number;
  /** Parent directory for the managed ssh config. For tests. */
  configBaseDir?: string;
}

const REMOTE_HANDSHAKE_TIMEOUT_MS = 60_000;
const CONTROL_EXIT_TIMEOUT_MS = 2_000;

export class SshTransport implements HostTransport {
  readonly handshakeTimeoutMs: number;

  private readonly spawnFn: SshSpawn;
  private readonly ensureRemoteHost: EnsureRemoteHost;
  private readonly configBaseDir: string | undefined;
  private config: ManagedSshConfig | null = null;
  private token: string | null = null;
  /** Spawns, tracks and reads every ssh child but the ControlMaster's own. */
  private readonly spawner: BridgeSpawner;
  /**
   * Set by `dispose()`, cleared only by `reset()`. While set nothing may
   * spawn ssh — otherwise a connect still in flight when the transport was
   * disposed would quietly recreate the config and a fresh ControlMaster.
   */
  private disposed = false;

  constructor(
    readonly target: string,
    opts: SshTransportOptions = {},
  ) {
    assertValidTarget(target);
    this.spawnFn = opts.spawn ?? defaultBridgeSpawn;
    this.ensureRemoteHost = opts.ensureRemoteHost ?? (async () => {});
    this.handshakeTimeoutMs = opts.handshakeTimeoutMs ?? REMOTE_HANDSHAKE_TIMEOUT_MS;
    this.configBaseDir = opts.configBaseDir;
    this.spawner = new BridgeSpawner({
      spawn: this.spawnFn,
      // `managedConfig()` throws once disposed, so nothing spawns then.
      buildArgv: (command) => [
        "ssh",
        ...buildSshArgs(this.managedConfig().configPath, this.target, command),
      ],
      label: target,
      program: "ssh",
      handshakeTimeoutMs: this.handshakeTimeoutMs,
      exitError: (code, stderr) => this.exitError(code, stderr),
    });
  }

  // ── ControlMaster accessors (for port forwarding on the shared session) ──

  /** The managed ssh config, created on first use. Throws once disposed. */
  managedConfig(): ManagedSshConfig {
    if (this.disposed) {
      throw new Error(`ssh transport to ${this.target} has been disposed`);
    }
    if (!this.config) this.config = createManagedSshConfig(this.configBaseDir);
    return this.config;
  }

  /**
   * Make a disposed transport usable again. The next connection starts from
   * scratch: a new managed config and a new ControlMaster.
   */
  reset(): void {
    this.disposed = false;
  }

  /** The config file passed with `-F`, or null before first use. */
  get configPath(): string | null {
    return this.config?.configPath ?? null;
  }

  /**
   * The ControlMaster socket for this target, as ssh expands the managed
   * config's `<dir>/%C` pattern (via `ssh -G`), or null before first use or
   * if ssh cannot say. Only needed to hand the socket to something other than
   * ssh — `ssh -F <configPath> -O …` (see `buildControlArgs`) finds it itself.
   */
  async resolveControlPath(): Promise<string | null> {
    const config = this.config;
    if (!config) return null;
    const child = this.spawner.spawnTracked(
      "ssh",
      ...buildResolveConfigArgs(config.configPath, this.target),
    );
    let out = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf-8");
    });
    child.stdin?.end();
    const code = await this.spawner
      .waitForExit(child, CONTROL_EXIT_TIMEOUT_MS)
      .catch(() => null);
    return code === 0 ? parseControlPath(out) : null;
  }

  // ── HostTransport ──

  async ensureRunning(version?: string): Promise<void> {
    this.managedConfig();
    await this.ensureRemoteHost(this.target, version, (command, opts) =>
      this.exec(command, opts),
    );
  }

  async restart(): Promise<void> {
    const { code, stderr } = await this.exec(remoteRestartCommand());
    if (code !== 0) throw this.exitError(code, stderr);
  }

  async connectControl(): Promise<Duplex> {
    return this.openDaemonBridge();
  }

  async connectStream(): Promise<Duplex> {
    return this.openDaemonBridge();
  }

  async authToken(): Promise<string> {
    if (this.token === null) {
      throw new Error(`No bridge to ${this.target} has announced a token yet`);
    }
    return this.token;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.spawner.killAll();
    const config = this.config;
    if (!config) return;
    this.config = null;
    // Close the ControlMaster before its socket's directory disappears,
    // otherwise it lingers for ControlPersist with nothing able to reach it.
    await this.spawner.waitForExit(
      this.spawnFn("ssh", buildControlArgs(config.configPath, this.target, "exit")),
      CONTROL_EXIT_TIMEOUT_MS,
    ).catch(() => {});
    removeManagedSshConfig(config);
  }

  /**
   * Open the owner channel to the box's host server (ADR-225 D4): one more
   * child on the shared ControlMaster, running `manor-host server-bridge`.
   *
   * Resolves once the server has said its hello reply (`parseServerHello`),
   * with the stream past it: what is left is bridge frames, one per line
   * (`backend/host-server-client.ts`). Rejects when the child exits before
   * the hello — no server on the box, or a `manor-host` too old to know the
   * command — with its stderr, or when the server refuses the owner. A child
   * that exits non-zero after the hello destroys the stream with that error.
   */
  async openServerBridge(): Promise<Duplex> {
    const { duplex } = await this.spawner.openBridge(remoteServerBridgeCommand(), parseServerHello, {
      exitIsError: true,
    });
    return duplex;
  }

  /**
   * Open a desktop window's viewer stream to the box's host server (ADR-228
   * D4): `manor-host server-bridge --viewer`, on the same ControlMaster as
   * the owner channel.
   *
   * Opened, refused and timed out exactly as `openServerBridge` is. The
   * difference is what the stream starts with: the server's hello reply line
   * is kept and replayed as its first line, because the window's transport —
   * not main — is the one waiting on it (`preAuthenticated`,
   * `src/bridge/transports/ws.ts`).
   */
  async openViewerBridge(): Promise<Duplex> {
    const { duplex } = await this.spawner.openBridge(
      remoteServerBridgeCommand({ viewer: true }),
      (line) => (parseServerHello(line) ? line : null),
      { exitIsError: true, replayHello: (line) => Buffer.from(`${line}\n`, "utf-8") },
    );
    return duplex;
  }

  // ── Internal ──

  /** Spawn one `remote-bridge` connection and take the token off its hello line. */
  private async openDaemonBridge(): Promise<Duplex> {
    const { hello, duplex } = await this.spawner.openBridge(remoteBridgeCommand(), parseHello);
    this.token = hello.token;
    return duplex;
  }

  /** Translate an ssh child that exited before its hello into a useful error. */
  private exitError(code: number | null, stderr: string): Error {
    if (isRemoteAuthError(stderr)) return new SshAuthError(this.target, stderr);
    if (isHostKeyError(stderr)) return new SshHostKeyError(this.target, stderr);
    const detail = stderr.trim();
    return new Error(
      `ssh to ${this.target} exited (code ${code ?? "unknown"}) before manor-host answered` +
        (detail ? `: ${detail}` : ""),
    );
  }

  /** Run a one-shot remote command over the shared session. See `RemoteExec`. */
  async exec(command: string, opts: RemoteExecOptions = {}): Promise<RemoteExecResult> {
    const result = await this.spawner.exec(command, opts);
    const { code, stderr } = result;
    if (code === 255 && isRemoteAuthError(stderr)) {
      throw new SshAuthError(this.target, stderr);
    }
    if (code === 255 && isHostKeyError(stderr)) {
      throw new SshHostKeyError(this.target, stderr);
    }
    return result;
  }
}
