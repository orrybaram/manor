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
import type { HelloReplyFrame } from "../bridge/types";
import type { HostTransport } from "./transport";
import { parseHello } from "./types";
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
  off(event: "error", listener: (err: Error) => void): this;
  off(
    event: "close" | "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
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

const REMOTE_HANDSHAKE_TIMEOUT_MS = 60_000;
/** Cap on bytes read hunting for the hello line (login-shell noise included). */
const MAX_PREAMBLE_BYTES = 64 * 1024;
/** Cap on stderr kept for diagnostics. */
const MAX_STDERR_BYTES = 16 * 1024;
const CONTROL_EXIT_TIMEOUT_MS = 2_000;

const defaultSpawn: SshSpawn = (command, args) =>
  nodeSpawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });

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
    /** What the child's exit means: an error to destroy with, or null for a clean end. */
    exitError?: (code: number | null) => Error | null,
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
    child.on("close", (code) => {
      this.childGone = true;
      this.destroy(exitError?.(code) ?? undefined);
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

/** A spawned bridge child and the stderr it has written so far. */
interface BridgeChild {
  child: SshChild;
  stdin: Writable;
  stdout: Readable;
  stderrText: string;
}

/** No hello line within the first `maxPreamble` bytes. */
class HelloPreambleError extends Error {
  constructor(readonly maxPreamble: number) {
    super(`no hello line in the first ${maxPreamble} bytes`);
    this.name = "HelloPreambleError";
  }
}

/**
 * Read `stream` up to the first line `parse` accepts, skipping what it
 * returns null for (login-shell noise). Resolves with the parsed hello and
 * the bytes already read past it, `stream` paused and no longer listened to.
 * Rejects when `parse` throws (a refusal) or more than `maxPreamble` bytes go
 * by without a hello. The stream ending first is the caller's to notice —
 * for an ssh child, its exit carries the better error.
 */
export function awaitHelloLine<T>(
  stream: Readable,
  parse: (line: string) => T | null,
  maxPreamble: number = MAX_PREAMBLE_BYTES,
): Promise<{ hello: T; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    /** Every byte read before the hello, including lines already skipped. */
    let preambleBytes = 0;
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk]);
      let nl: number;
      while ((nl = buffered.indexOf(0x0a)) >= 0) {
        const line = buffered.subarray(0, nl).toString("utf-8").trim();
        buffered = buffered.subarray(nl + 1);
        let hello: T | null;
        try {
          hello = parse(line);
        } catch (err) {
          stream.off("data", onData);
          reject(err);
          return;
        }
        if (hello === null) {
          preambleBytes += nl + 1;
          if (preambleBytes > maxPreamble) break;
          continue;
        }
        stream.pause();
        stream.off("data", onData);
        resolve({ hello, rest: buffered });
        return;
      }
      if (preambleBytes + buffered.length > maxPreamble) {
        stream.off("data", onData);
        reject(new HelloPreambleError(maxPreamble));
      }
    };
    stream.on("data", onData);
  });
}

/**
 * The host server's reply to the owner hello (`server-bridge` says it on
 * the desktop's behalf): `{"type":"hello","ok":true,…}`. A line that is not
 * JSON is login-shell noise (null); a `{"kind":"close",…}` is the server
 * refusing the owner, and throws.
 */
export function parseServerHello(line: string): HelloReplyFrame | null {
  let frame: unknown;
  try {
    frame = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof frame !== "object" || frame === null) return null;
  const f = frame as Record<string, unknown>;
  if (f.type === "hello" && f.ok === true) return frame as HelloReplyFrame;
  if (f.kind === "close") {
    throw new Error(
      `the host server refused the owner (${String(f.code)}${f.reason ? `: ${String(f.reason)}` : ""})`,
    );
  }
  return null;
}

export class SshTransport implements HostTransport {
  readonly handshakeTimeoutMs: number;

  private readonly spawnFn: SshSpawn;
  private readonly ensureRemoteHost: EnsureRemoteHost;
  private readonly configBaseDir: string | undefined;
  private config: ManagedSshConfig | null = null;
  private token: string | null = null;
  private readonly children = new Set<SshChild>();
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
    this.spawnFn = opts.spawn ?? defaultSpawn;
    this.ensureRemoteHost = opts.ensureRemoteHost ?? (async () => {});
    this.handshakeTimeoutMs = opts.handshakeTimeoutMs ?? REMOTE_HANDSHAKE_TIMEOUT_MS;
    this.configBaseDir = opts.configBaseDir;
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
    const child = this.spawnFn("ssh", buildResolveConfigArgs(config.configPath, this.target));
    this.track(child);
    let out = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf-8");
    });
    child.stdin?.end();
    const code = await this.waitForExit(child, CONTROL_EXIT_TIMEOUT_MS).catch(() => null);
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
    const { duplex } = await this.openBridge(remoteServerBridgeCommand(), parseServerHello, {
      exitIsError: true,
    });
    return duplex;
  }

  // ── Internal ──

  /** Spawn one `remote-bridge` connection and take the token off its hello line. */
  private async openDaemonBridge(): Promise<Duplex> {
    const { hello, duplex } = await this.openBridge(remoteBridgeCommand(), parseHello);
    this.token = hello.token;
    return duplex;
  }

  /**
   * Spawn `ssh … <command>` on the shared session and track it. Its stderr
   * is kept (the last `MAX_STDERR_BYTES`) for the error an early exit makes.
   */
  private spawnBridgeChild(command: string): BridgeChild {
    const { configPath } = this.managedConfig();
    const child = this.spawnFn("ssh", buildSshArgs(configPath, this.target, command));
    this.track(child);
    const { stdin, stdout, stderr } = child;
    if (!stdin || !stdout || !stderr) {
      child.kill("SIGTERM");
      throw new Error("ssh child is missing piped stdio");
    }
    const bridge: BridgeChild = { child, stdin, stdout, stderrText: "" };
    stderr.on("data", (chunk: Buffer) => {
      bridge.stderrText = (bridge.stderrText + chunk.toString("utf-8")).slice(-MAX_STDERR_BYTES);
    });
    return bridge;
  }

  /**
   * One bridge child, read up to its hello line (`parse`) and handed back
   * as a `Duplex` over the bytes after it. Rejects — killing the child —
   * when ssh cannot run, exits first, or the handshake timeout passes.
   */
  private async openBridge<T>(
    command: string,
    parse: (line: string) => T | null,
    /** A non-zero exit after the hello destroys the stream with ssh's error. */
    opts: { exitIsError?: boolean } = {},
  ): Promise<{ hello: T; duplex: Duplex }> {
    const bridge = this.spawnBridgeChild(command);
    const { child, stdin, stdout } = bridge;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onError: ((err: Error) => void) | undefined;
    let onClose: ((code: number | null) => void) | undefined;
    const failed = new Promise<never>((_resolve, reject) => {
      onError = (err) => reject(new Error(`Could not run ssh for ${this.target}: ${err.message}`));
      onClose = (code) => reject(this.exitError(code, bridge.stderrText));
      child.on("error", onError);
      child.on("close", onClose);
      timer = setTimeout(() => {
        const detail = bridge.stderrText.trim();
        reject(
          new Error(
            `Timed out after ${Math.round(this.handshakeTimeoutMs / 1000)}s waiting for manor-host on ${this.target}` +
              (detail ? `: ${detail}` : ""),
          ),
        );
      }, this.handshakeTimeoutMs);
    });
    const helloed = awaitHelloLine(stdout, parse).catch((err: unknown) => {
      if (err instanceof HelloPreambleError) {
        throw new Error(
          `manor-host on ${this.target} did not announce itself (no hello in the first ${err.maxPreamble} bytes)`,
        );
      }
      throw err;
    });
    // Whichever loses the race below settles unheard.
    helloed.catch(() => {});
    failed.catch(() => {});
    try {
      const { hello, rest } = await Promise.race([helloed, failed]);
      const duplex = new SshChildDuplex(
        child,
        stdin,
        stdout,
        rest,
        opts.exitIsError
          ? (code) => (code === 0 || code === null ? null : this.exitError(code, bridge.stderrText))
          : undefined,
      );
      return { hello, duplex };
    } catch (err) {
      child.kill("SIGTERM");
      throw err;
    } finally {
      clearTimeout(timer);
      if (onError) child.off("error", onError);
      if (onClose) child.off("close", onClose);
    }
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
    if (code === 255 && isHostKeyError(stderr)) {
      throw new SshHostKeyError(this.target, stderr);
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
