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
 */

import { spawn as nodeSpawn } from "node:child_process";
import { Duplex, type Readable, type Writable } from "node:stream";
import type { HostTransport } from "./transport";
import {
  SshAuthError,
  assertValidTarget,
  buildControlArgs,
  buildSshArgs,
  createManagedSshConfig,
  isRemoteAuthError,
  remoteBridgeCommand,
  remoteRestartCommand,
  removeManagedSshConfig,
  type ManagedSshConfig,
} from "./ssh-config";

/** The slice of `ChildProcess` this transport uses. Narrow so tests can fake it. */
export interface SshChild {
  stdin: Writable | null;
  stdout: Readable | null;
  stderr: Readable | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: "error", listener: (err: Error) => void): this;
  on(
    event: "close" | "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  off(event: "error" | "close" | "exit", listener: (...args: never[]) => void): this;
}

export type SshSpawn = (command: string, args: string[]) => SshChild;

/** What a one-shot remote command produced. */
export interface RemoteExecResult {
  /** Exit code; null when ssh was killed by a signal. */
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface RemoteExecOptions {
  /** Bytes fed to the remote command's stdin (closed after). Defaults to none. */
  stdin?: Buffer | string;
  /** Kill ssh after this long. Defaults to the transport's handshake timeout. */
  timeoutMs?: number;
}

/**
 * Run `command` through the remote login shell over the shared ssh session.
 * Resolves with whatever the command produced — a non-zero exit is data, not
 * an error. Rejects only when ssh itself could not run, auth failed, or the
 * timeout expired.
 */
export type RemoteExec = (
  command: string,
  opts?: RemoteExecOptions,
) => Promise<RemoteExecResult>;

/**
 * Makes sure the remote box has a `manor-host` able to serve `version`
 * (installing or upgrading it if not). Supplied by the bootstrap module
 * (`electron/backend/remote-bootstrap.ts`); `exec` runs commands over this
 * transport's ControlMaster session.
 */
export type EnsureRemoteHost = (
  target: string,
  version: string | undefined,
  exec: RemoteExec,
) => Promise<void>;

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

/** The one-line JSON preamble `remote-bridge` writes before any protocol bytes. */
interface BridgeHello {
  type: "bridgeHello";
  token: string;
  daemonVersion: string | null;
}

const REMOTE_HANDSHAKE_TIMEOUT_MS = 60_000;
/** Cap on bytes read hunting for the hello line (login-shell noise included). */
const MAX_PREAMBLE_BYTES = 64 * 1024;
/** Cap on stderr kept for diagnostics. */
const MAX_STDERR_BYTES = 16 * 1024;
const CONTROL_EXIT_TIMEOUT_MS = 2_000;

const defaultSpawn: SshSpawn = (command, args) =>
  nodeSpawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });

function parseHello(line: string): BridgeHello | null {
  try {
    const value = JSON.parse(line) as Partial<BridgeHello> | null;
    if (value && value.type === "bridgeHello" && typeof value.token === "string") {
      return {
        type: "bridgeHello",
        token: value.token,
        daemonVersion:
          typeof value.daemonVersion === "string" ? value.daemonVersion : null,
      };
    }
  } catch {
    // Not JSON — shell rc noise ahead of the preamble.
  }
  return null;
}

/**
 * A `Duplex` over an ssh child's stdin/stdout. Destroying it kills the child;
 * the child exiting closes it — which is how the client notices a lost host.
 */
class SshChildDuplex extends Duplex {
  private childGone = false;

  constructor(
    private readonly child: SshChild,
    private readonly stdin: Writable,
    private readonly stdout: Readable,
    leftover: Buffer,
  ) {
    super();
    if (leftover.length > 0) this.push(leftover);
    stdout.on("data", (chunk: Buffer) => {
      if (!this.push(chunk)) stdout.pause();
    });
    stdout.on("end", () => this.push(null));
    stdin.on("error", () => {
      // EPIPE once ssh is gone; `close` below reports the loss.
    });
    child.on("close", () => {
      this.childGone = true;
      this.destroy();
    });
    // Stays paused until the consumer reads (`_read` resumes it).
  }

  _read(): void {
    this.stdout.resume();
  }

  _write(
    chunk: Buffer,
    encoding: BufferEncoding,
    callback: (err?: Error | null) => void,
  ): void {
    this.stdin.write(chunk, encoding, (err) => callback(err ?? null));
  }

  _final(callback: (err?: Error | null) => void): void {
    this.stdin.end(callback);
  }

  _destroy(err: Error | null, callback: (err: Error | null) => void): void {
    if (!this.childGone) this.child.kill("SIGTERM");
    callback(err);
  }
}

export class SshTransport implements HostTransport {
  readonly handshakeTimeoutMs: number;

  private readonly spawnFn: SshSpawn;
  private readonly ensureRemoteHost: EnsureRemoteHost;
  private readonly configBaseDir: string | undefined;
  private config: ManagedSshConfig | null = null;
  private token: string | null = null;
  private _daemonVersion: string | null = null;
  private readonly children = new Set<SshChild>();

  constructor(
    readonly target: string,
    opts: SshTransportOptions = {},
  ) {
    assertValidTarget(target);
    this.spawnFn = opts.spawn ?? defaultSpawn;
    this.ensureRemoteHost = opts.ensureRemoteHost ?? (async () => {});
    this.handshakeTimeoutMs = opts.handshakeTimeoutMs ?? REMOTE_HANDSHAKE_TIMEOUT_MS;
    this.configBaseDir = opts.configBaseDir;
  }

  // ── ControlMaster accessors (for port forwarding on the shared session) ──

  /** The managed ssh config, created on first use. */
  managedConfig(): ManagedSshConfig {
    if (!this.config) this.config = createManagedSshConfig(this.configBaseDir);
    return this.config;
  }

  /** The config file passed with `-F`, or null before first use. */
  get configPath(): string | null {
    return this.config?.configPath ?? null;
  }

  /** The ControlMaster socket, or null before first use. */
  get controlPath(): string | null {
    return this.config?.controlPath ?? null;
  }

  /** The daemon version the last `bridgeHello` reported. */
  get daemonVersion(): string | null {
    return this._daemonVersion;
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

  connectControl(): Promise<Duplex> {
    return this.openBridge(false);
  }

  connectStream(): Promise<Duplex> {
    return this.openBridge(true);
  }

  async authToken(): Promise<string> {
    if (this.token === null) {
      throw new Error(`No bridge to ${this.target} has announced a token yet`);
    }
    return this.token;
  }

  async dispose(): Promise<void> {
    for (const child of this.children) child.kill("SIGTERM");
    this.children.clear();
    const config = this.config;
    if (!config) return;
    this.config = null;
    // Close the ControlMaster before its socket's directory disappears,
    // otherwise it lingers for ControlPersist with nothing able to reach it.
    await this.waitForExit(
      this.spawnFn("ssh", buildControlArgs(config.configPath, this.target, "exit")),
      CONTROL_EXIT_TIMEOUT_MS,
    ).catch(() => {});
    removeManagedSshConfig(config);
  }

  // ── Internal ──

  /** Spawn one `remote-bridge` connection and strip its hello line. */
  private openBridge(stream: boolean): Promise<Duplex> {
    const { configPath } = this.managedConfig();
    const child = this.spawnFn(
      "ssh",
      buildSshArgs(configPath, this.target, remoteBridgeCommand(stream)),
    );
    this.track(child);
    const { stdin, stdout, stderr } = child;
    if (!stdin || !stdout || !stderr) {
      child.kill("SIGTERM");
      return Promise.reject(new Error("ssh child is missing piped stdio"));
    }

    let stderrText = "";
    stderr.on("data", (chunk: Buffer) => {
      stderrText = (stderrText + chunk.toString("utf-8")).slice(-MAX_STDERR_BYTES);
    });

    return new Promise<Duplex>((resolve, reject) => {
      let buffered = Buffer.alloc(0);
      let settled = false;

      const finish = (err: Error | null, duplex?: Duplex): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        stdout.off("data", onData);
        child.off("error", onError);
        child.off("close", onClose);
        if (err) {
          child.kill("SIGTERM");
          reject(err);
        } else {
          resolve(duplex!);
        }
      };

      const onData = (chunk: Buffer): void => {
        buffered = Buffer.concat([buffered, chunk]);
        let nl: number;
        while ((nl = buffered.indexOf(0x0a)) >= 0) {
          const line = buffered.subarray(0, nl).toString("utf-8").trim();
          buffered = buffered.subarray(nl + 1);
          const hello = parseHello(line);
          if (!hello) continue;
          this.token = hello.token;
          this._daemonVersion = hello.daemonVersion;
          stdout.pause();
          stdout.off("data", onData);
          finish(null, new SshChildDuplex(child, stdin, stdout, buffered));
          return;
        }
        if (buffered.length > MAX_PREAMBLE_BYTES) {
          finish(
            new Error(
              `manor-host on ${this.target} did not announce itself (no bridgeHello in the first ${MAX_PREAMBLE_BYTES} bytes)`,
            ),
          );
        }
      };

      const onError = (err: Error): void => {
        finish(new Error(`Could not run ssh for ${this.target}: ${err.message}`));
      };

      const onClose = (code: number | null): void => {
        finish(this.exitError(code, stderrText));
      };

      const timer = setTimeout(() => {
        finish(
          new Error(
            `Timed out after ${Math.round(this.handshakeTimeoutMs / 1000)}s waiting for manor-host on ${this.target}` +
              (stderrText.trim() ? `: ${stderrText.trim()}` : ""),
          ),
        );
      }, this.handshakeTimeoutMs);

      stdout.on("data", onData);
      child.on("error", onError);
      child.on("close", onClose);
    });
  }

  /** Translate an ssh child that exited before its hello into a useful error. */
  private exitError(code: number | null, stderr: string): Error {
    if (isRemoteAuthError(stderr)) return new SshAuthError(this.target, stderr);
    const detail = stderr.trim();
    return new Error(
      `ssh to ${this.target} exited (code ${code ?? "unknown"}) before manor-host answered` +
        (detail ? `: ${detail}` : ""),
    );
  }

  /** Run a one-shot remote command over the shared session. See `RemoteExec`. */
  async exec(command: string, opts: RemoteExecOptions = {}): Promise<RemoteExecResult> {
    const { configPath } = this.managedConfig();
    const child = this.spawnFn("ssh", buildSshArgs(configPath, this.target, command));
    this.track(child);
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf-8")).slice(-MAX_STDERR_BYTES);
    });
    child.stdin?.on("error", () => {
      // EPIPE when the remote command exits without draining stdin.
    });
    if (opts.stdin !== undefined) child.stdin?.end(opts.stdin);
    else child.stdin?.end();
    const code = await this.waitForExit(child, opts.timeoutMs ?? this.handshakeTimeoutMs);
    if (code === 255 && isRemoteAuthError(stderr)) {
      throw new SshAuthError(this.target, stderr);
    }
    return { code, stdout, stderr };
  }

  private track(child: SshChild): void {
    this.children.add(child);
    child.on("close", () => this.children.delete(child));
    // Without a listener an ENOENT (no ssh on PATH) would be thrown.
    child.on("error", () => {});
  }

  private waitForExit(child: SshChild, timeoutMs: number): Promise<number | null> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`ssh to ${this.target} timed out`));
      }, timeoutMs);
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
  }
}
