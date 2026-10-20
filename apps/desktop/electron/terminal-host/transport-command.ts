/**
 * CommandTransport — reaches a terminal-host daemon on a box with no sshd,
 * through any command that runs a process there with stdio attached:
 * `kubectl exec -i … --`, `docker exec -i <name>`.
 *
 * Built from that command as an argv prefix. Every child is
 * `[...argv, "sh", "-c", snippet]`, where `snippet` is the same POSIX sh
 * `SshTransport` sends (`remoteBridgeCommand`, `remoteServerBridgeCommand`,
 * the bootstrap's own), so the daemon, owner and viewer bridges and the
 * bootstrap are the shared `BridgeSpawner`'s code on both transports.
 *
 * There is no ControlMaster: every stream is its own child, which
 * `kubectl`/`docker` are designed for. Port forwards ride `manor-host
 * port-pipe` children instead (`CommandHostProvider.forwardPort`).
 */

import { basename } from "node:path";
import type { Duplex } from "node:stream";
import type { HostTransport } from "./transport";
import { parseHello } from "./types";
import {
  BridgeSpawner,
  defaultBridgeSpawn,
  parseServerHello,
  type BridgeSpawn,
  type EnsureRemoteHost,
  type RemoteExecOptions,
  type RemoteExecResult,
} from "./bridge-spawner";
import {
  remoteBridgeCommand,
  remoteRestartCommand,
  remoteServerBridgeCommand,
} from "./ssh-config";

export interface CommandTransportOptions {
  /** Defaults to `child_process.spawn` with piped stdio. */
  spawn?: BridgeSpawn;
  /** Defaults to a stub that assumes the host binary is already installed. */
  ensureRemoteHost?: EnsureRemoteHost;
  /**
   * How long to wait for a bridge's hello, and for the client's auth and
   * handshake replies. A cold `kubectl exec` (API server, scheduling the
   * exec, container runtime) can take several seconds before the box's end
   * even starts, hence longer than ssh's.
   */
  handshakeTimeoutMs?: number;
  /** How messages name the box. Defaults to the argv prefix, joined. */
  label?: string;
}

const COMMAND_HANDSHAKE_TIMEOUT_MS = 120_000;

/** The child that runs the POSIX `sh` snippet `snippet` on the box through `argv`. */
export function commandArgv(argv: readonly string[], snippet: string): [string, ...string[]] {
  const [program, ...args] = [...argv, "sh", "-c", snippet];
  return [program, ...args];
}

export class CommandTransport implements HostTransport {
  readonly handshakeTimeoutMs: number;
  /** How messages name the box. */
  readonly label: string;

  private readonly argv: readonly string[];
  private readonly ensureRemoteHost: EnsureRemoteHost;
  private readonly spawner: BridgeSpawner;
  private token: string | null = null;
  /**
   * Set by `dispose()`, cleared only by `reset()`. While set nothing may
   * spawn — a connect still in flight when the transport was disposed must
   * not start a fresh bridge.
   */
  private disposed = false;

  constructor(argv: readonly string[], opts: CommandTransportOptions = {}) {
    this.argv = Object.freeze([...argv]);
    this.label = opts.label ?? (argv.length > 0 ? argv.join(" ") : "this machine");
    this.ensureRemoteHost = opts.ensureRemoteHost ?? (async () => {});
    this.handshakeTimeoutMs = opts.handshakeTimeoutMs ?? COMMAND_HANDSHAKE_TIMEOUT_MS;
    const [program] = commandArgv(this.argv, "");
    this.spawner = new BridgeSpawner({
      spawn: opts.spawn ?? defaultBridgeSpawn,
      buildArgv: (command) => this.childArgv(command),
      label: this.label,
      program: basename(program),
      handshakeTimeoutMs: this.handshakeTimeoutMs,
      exitError: (code, stderr) => {
        const detail = stderr.trim();
        return new Error(
          `${basename(program)} for ${this.label} exited (code ${code ?? "unknown"}) before manor-host answered` +
            (detail ? `: ${detail}` : ""),
        );
      },
    });
  }

  /**
   * The full argv that runs `snippet` on the box. Throws once disposed. For
   * the provider's own children (port pipes), which are not bridges.
   */
  childArgv(snippet: string): [string, ...string[]] {
    if (this.disposed) {
      throw new Error(`exec transport to ${this.label} has been disposed`);
    }
    return commandArgv(this.argv, snippet);
  }

  /** Make a disposed transport usable again. */
  reset(): void {
    this.disposed = false;
  }

  // ── HostTransport ──

  async ensureRunning(version?: string): Promise<void> {
    if (this.disposed) {
      throw new Error(`exec transport to ${this.label} has been disposed`);
    }
    await this.ensureRemoteHost(this.label, version, (command, opts) =>
      this.exec(command, opts),
    );
  }

  async restart(): Promise<void> {
    const { code, stderr } = await this.exec(remoteRestartCommand());
    if (code !== 0) {
      const detail = stderr.trim();
      throw new Error(
        `manor-host restart on ${this.label} exited (code ${code ?? "unknown"})` +
          (detail ? `: ${detail}` : ""),
      );
    }
  }

  async connectControl(): Promise<Duplex> {
    return this.openDaemonBridge();
  }

  async connectStream(): Promise<Duplex> {
    return this.openDaemonBridge();
  }

  async authToken(): Promise<string> {
    if (this.token === null) {
      throw new Error(`No bridge to ${this.label} has announced a token yet`);
    }
    return this.token;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.spawner.killAll();
  }

  /**
   * Open the owner channel to the box's host server as
   * `SshTransport.openServerBridge` does: `manor-host server-bridge` in its
   * own exec child, read past the server's hello reply.
   */
  async openServerBridge(): Promise<Duplex> {
    const { duplex } = await this.spawner.openBridge(
      remoteServerBridgeCommand(),
      parseServerHello,
      { exitIsError: true },
    );
    return duplex;
  }

  /**
   * Open a desktop window's viewer stream as
   * `SshTransport.openViewerBridge` does: the server's hello reply kept as
   * the stream's first line.
   */
  async openViewerBridge(): Promise<Duplex> {
    const { duplex } = await this.spawner.openBridge(
      remoteServerBridgeCommand({ viewer: true }),
      (line) => (parseServerHello(line) ? line : null),
      { exitIsError: true, replayHello: (line) => Buffer.from(`${line}\n`, "utf-8") },
    );
    return duplex;
  }

  /** Run a one-shot command on the box in its own exec child. See `RemoteExec`. */
  exec(command: string, opts: RemoteExecOptions = {}): Promise<RemoteExecResult> {
    return this.spawner.exec(command, opts);
  }

  // ── Internal ──

  /** Spawn one `remote-bridge` connection and take the token off its hello line. */
  private async openDaemonBridge(): Promise<Duplex> {
    const { hello, duplex } = await this.spawner.openBridge(remoteBridgeCommand(), parseHello);
    this.token = hello.token;
    return duplex;
  }
}
