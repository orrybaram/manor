/**
 * BridgeSpawner — the child-process half of a remote transport, shared by
 * `SshTransport` and `CommandTransport` (ADR-229 D3).
 *
 * A remote transport reaches the box by running one command there with
 * stdio attached: `ssh -T <target> <cmd>` on a ControlMaster, or an exec
 * prefix such as `kubectl exec -i … -- sh -c <cmd>`. Everything past "which
 * argv runs `<cmd>` on the box" is the same for both, and lives here:
 * spawning and tracking the children, reading each bridge up to its hello
 * line (`awaitHelloLine`), handing what follows over as a `Duplex`, and
 * turning a child's early exit into an error the transport words.
 */

import { spawn as nodeSpawn } from "node:child_process";
import { Duplex, type Readable, type Writable } from "node:stream";
import type { HelloReplyFrame } from "../bridge/types";

/** The slice of `ChildProcess` a transport uses. Narrow so tests can fake it. */
export interface BridgeChildProcess {
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

export type BridgeSpawn = (command: string, args: string[]) => BridgeChildProcess;

/** What a one-shot remote command produced. */
export interface RemoteExecResult {
  /** Exit code; null when the child was killed by a signal. */
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface RemoteExecOptions {
  /** Bytes fed to the remote command's stdin (closed after). Defaults to none. */
  stdin?: Buffer | string;
  /** Kill the child after this long. Defaults to the transport's handshake timeout. */
  timeoutMs?: number;
}

/**
 * Run `command` on the box through the transport (over the shared ssh
 * session, or one exec child). Resolves with whatever the command produced —
 * a non-zero exit is data, not an error. Rejects only when the transport
 * itself could not run, auth failed, or the timeout expired.
 */
export type RemoteExec = (
  command: string,
  opts?: RemoteExecOptions,
) => Promise<RemoteExecResult>;

/**
 * Makes sure the remote box has a `manor-host` able to serve `version`
 * (installing or upgrading it if not). Supplied by the bootstrap module
 * (`electron/backend/remote-bootstrap.ts`); `exec` runs commands over the
 * transport.
 */
export type EnsureRemoteHost = (
  target: string,
  version: string | undefined,
  exec: RemoteExec,
) => Promise<void>;

/** Cap on bytes read hunting for the hello line (login-shell noise included). */
const MAX_PREAMBLE_BYTES = 64 * 1024;
/** Cap on stderr kept for diagnostics. */
const MAX_STDERR_BYTES = 16 * 1024;

export const defaultBridgeSpawn: BridgeSpawn = (command, args) =>
  nodeSpawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });

/**
 * A `Duplex` over a bridge child's stdin/stdout. Destroying it kills the
 * child; the child exiting closes it — which is how the client notices a
 * lost host.
 */
class ChildDuplex extends Duplex {
  private childGone = false;

  constructor(
    private readonly child: BridgeChildProcess,
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
      // EPIPE once the child is gone; `close` below reports the loss.
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
  child: BridgeChildProcess;
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
 * for a bridge child, its exit carries the better error.
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

export interface BridgeSpawnerOptions {
  spawn: BridgeSpawn;
  /**
   * The argv that runs the POSIX `sh` snippet `remoteCommand` on the box.
   * May throw — a disposed transport refuses here, before anything spawns.
   */
  buildArgv: (remoteCommand: string) => [string, ...string[]];
  /** The box, as messages name it (`user@box`, `kubectl exec … pod`). */
  label: string;
  /** What runs the children, as messages name it (`ssh`, `kubectl`). */
  program: string;
  handshakeTimeoutMs: number;
  /** Translate a child that exited before its hello into a useful error. */
  exitError: (code: number | null, stderr: string) => Error;
}

/** Options for one `BridgeSpawner.openBridge`. */
export interface OpenBridgeOptions<T> {
  /** A non-zero exit after the hello destroys the stream with the child's error. */
  exitIsError?: boolean;
  /** Bytes to put back in front of the stream, in place of the hello line. */
  replayHello?: (hello: T) => Buffer;
}

export class BridgeSpawner {
  private readonly children = new Set<BridgeChildProcess>();

  constructor(private readonly opts: BridgeSpawnerOptions) {}

  /**
   * One bridge child running `command`, read up to its hello line (`parse`)
   * and handed back as a `Duplex` over the bytes after it. Rejects — killing
   * the child — when the child cannot run, exits first, or the handshake
   * timeout passes.
   */
  async openBridge<T>(
    command: string,
    parse: (line: string) => T | null,
    opts: OpenBridgeOptions<T> = {},
  ): Promise<{ hello: T; duplex: Duplex }> {
    const { label, program, handshakeTimeoutMs, exitError } = this.opts;
    const bridge = this.spawnBridgeChild(command);
    const { child, stdin, stdout } = bridge;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onError: ((err: Error) => void) | undefined;
    let onClose: ((code: number | null) => void) | undefined;
    const failed = new Promise<never>((_resolve, reject) => {
      onError = (err) => reject(new Error(`Could not run ${program} for ${label}: ${err.message}`));
      onClose = (code) => reject(exitError(code, bridge.stderrText));
      child.on("error", onError);
      child.on("close", onClose);
      timer = setTimeout(() => {
        const detail = bridge.stderrText.trim();
        reject(
          new Error(
            `Timed out after ${Math.round(handshakeTimeoutMs / 1000)}s waiting for manor-host on ${label}` +
              (detail ? `: ${detail}` : ""),
          ),
        );
      }, handshakeTimeoutMs);
    });
    const helloed = awaitHelloLine(stdout, parse).catch((err: unknown) => {
      if (err instanceof HelloPreambleError) {
        throw new Error(
          `manor-host on ${label} did not announce itself (no hello in the first ${err.maxPreamble} bytes)`,
        );
      }
      throw err;
    });
    // Whichever loses the race below settles unheard.
    helloed.catch(() => {});
    failed.catch(() => {});
    try {
      const { hello, rest } = await Promise.race([helloed, failed]);
      const duplex = new ChildDuplex(
        child,
        stdin,
        stdout,
        opts.replayHello ? Buffer.concat([opts.replayHello(hello), rest]) : rest,
        opts.exitIsError
          ? (code) => (code === 0 || code === null ? null : exitError(code, bridge.stderrText))
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

  /**
   * Run a one-shot remote command and collect what it produced. A non-zero
   * exit is data; only a child that cannot run, or the timeout, rejects.
   * Transport-specific failures (ssh's auth, host keys) are the caller's to
   * read off the result.
   */
  async exec(command: string, opts: RemoteExecOptions = {}): Promise<RemoteExecResult> {
    const child = this.spawnTracked(...this.opts.buildArgv(command));
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
    const code = await this.waitForExit(child, opts.timeoutMs ?? this.opts.handshakeTimeoutMs);
    return { code, stdout, stderr };
  }

  /** Spawn `command args…` and track it, so `killAll` reaches it. */
  spawnTracked(command: string, ...args: string[]): BridgeChildProcess {
    const child = this.opts.spawn(command, args);
    this.track(child);
    return child;
  }

  /** Kill every child still running and forget them. */
  killAll(): void {
    for (const child of this.children) child.kill("SIGTERM");
    this.children.clear();
  }

  /**
   * The child's exit code, or a rejection when it cannot run or outlives
   * `timeoutMs` (it is killed then).
   */
  waitForExit(child: BridgeChildProcess, timeoutMs: number): Promise<number | null> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`${this.opts.program} to ${this.opts.label} timed out`));
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

  // ── Internal ──

  /**
   * Spawn the child that runs `command` and track it. Its stderr is kept
   * (the last `MAX_STDERR_BYTES`) for the error an early exit makes.
   */
  private spawnBridgeChild(command: string): BridgeChild {
    const child = this.spawnTracked(...this.opts.buildArgv(command));
    const { stdin, stdout, stderr } = child;
    if (!stdin || !stdout || !stderr) {
      child.kill("SIGTERM");
      throw new Error(`${this.opts.program} child is missing piped stdio`);
    }
    const bridge: BridgeChild = { child, stdin, stdout, stderrText: "" };
    stderr.on("data", (chunk: Buffer) => {
      bridge.stderrText = (bridge.stderrText + chunk.toString("utf-8")).slice(-MAX_STDERR_BYTES);
    });
    return bridge;
  }

  private track(child: BridgeChildProcess): void {
    this.children.add(child);
    child.on("close", () => this.children.delete(child));
    // Without a listener an ENOENT (the program not on PATH) would be thrown.
    child.on("error", () => {});
  }
}
