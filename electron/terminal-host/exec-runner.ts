/**
 * Exec bookkeeping for the terminal-host daemon.
 *
 * Two shapes are needed on top of a plain child process: a request/response
 * `exec` that waits for completion and returns capped output, and a
 * streaming `execStream` whose chunks are pushed as they arrive and whose
 * child must be cancelable and reachable by `execId` — including when the
 * stream socket that started it disconnects.
 *
 * This is an arbitrary-command execution surface reachable behind the
 * token-gated daemon socket. Every spawn here uses an argv array — never
 * `shell: true` — and only the argv[0] is logged, not full argv or output,
 * since either can carry secrets.
 *
 * Every child is spawned as the leader of its own process group
 * (`detached: true`) so that killing it also kills whatever it spawned: a
 * `git` that forks helpers, or `sh -c 'sleep 100 & …'`. Termination sends
 * SIGTERM to the group and escalates to SIGKILL after
 * `KILL_ESCALATION_MS`. Completion is taken from the child's `exit`, plus a
 * short grace for stdio to drain, rather than waiting on `close` alone —
 * `close` never fires while a grandchild still holds the pipes open.
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

/** Matches `LocalGitBackend.execGit`'s default. */
export const DEFAULT_EXEC_TIMEOUT_MS = 30000;

/** Output cap applied independently to stdout and stderr. */
export const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;

/** Upper bound on a client-supplied `maxBuffer`. */
export const MAX_MAX_BUFFER = 64 * 1024 * 1024;

/** Largest delay `setTimeout` honors; anything above it fires immediately. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** How long after SIGTERM a process group gets before SIGKILL. */
export const KILL_ESCALATION_MS = 2000;

/**
 * How long after the child's `exit` to wait for its stdio to close before
 * giving up on it. Normally `close` follows `exit` within milliseconds; if it
 * does not, something else (a backgrounded grandchild) holds the pipes.
 */
export const EXIT_DRAIN_GRACE_MS = 250;

const TRUNCATION_SUFFIX = "\n…[truncated]";

/** Append-with-cap: once truncated, further chunks are dropped. */
function appendCapped(
  current: string,
  chunk: string,
  maxBuffer: number,
): { value: string; truncated: boolean } {
  if (current.endsWith(TRUNCATION_SUFFIX)) {
    return { value: current, truncated: true };
  }
  const combined = current + chunk;
  if (combined.length <= maxBuffer) {
    return { value: combined, truncated: false };
  }
  return {
    value: combined.slice(0, maxBuffer) + TRUNCATION_SUFFIX,
    truncated: true,
  };
}

/**
 * Normalize a client-supplied timeout. `0` (or any non-positive value) means
 * no timeout, matching `execFile`; values past what a timer can hold are
 * clamped rather than wrapping around to fire immediately. Returns `null` for
 * "no timeout".
 */
export function normalizeTimeout(timeout: number | undefined): number | null {
  if (timeout === undefined || !Number.isFinite(timeout)) {
    return timeout === Infinity ? null : DEFAULT_EXEC_TIMEOUT_MS;
  }
  if (timeout <= 0) return null;
  return Math.min(timeout, MAX_TIMER_MS);
}

/** Normalize a client-supplied `maxBuffer` to `[0, MAX_MAX_BUFFER]`. */
export function normalizeMaxBuffer(maxBuffer: number | undefined): number {
  if (maxBuffer === undefined || Number.isNaN(maxBuffer)) {
    return DEFAULT_MAX_BUFFER;
  }
  return Math.max(0, Math.min(maxBuffer, MAX_MAX_BUFFER));
}

function spawnInGroup(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string> },
): ChildProcess {
  return spawn(cmd, args, {
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    shell: false,
    // Own process group, so the whole tree can be signalled at once.
    detached: true,
    // Nothing is ever written to the child; a pipe it could block reading
    // from would only hang commands that prompt.
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // ESRCH: the whole group is already gone. Anything else (no group
    // support): fall back to the child alone.
    try {
      child.kill(signal);
    } catch {
      /* already exited */
    }
  }
}

/**
 * SIGTERM the child's process group, then SIGKILL it if anything in the
 * group is still alive after `KILL_ESCALATION_MS`. The escalation runs even
 * if the leader exits promptly, since a grandchild may ignore SIGTERM.
 */
function terminateGroup(child: ChildProcess): void {
  signalGroup(child, "SIGTERM");
  const timer = setTimeout(
    () => signalGroup(child, "SIGKILL"),
    KILL_ESCALATION_MS,
  );
  timer.unref();
}

/**
 * Call `onDone` exactly once, when the child has finished: on `close`, on a
 * spawn `error`, or `EXIT_DRAIN_GRACE_MS` after `exit` if its stdio is still
 * open by then (at which point the pipes are destroyed). Node resumes a
 * child's paused stdio itself once the child exits, so a backpressure pause
 * cannot hold this open.
 */
function watchCompletion(
  child: ChildProcess,
  onDone: (exitCode: number | null, error?: string) => void,
): void {
  let done = false;
  let drainTimer: ReturnType<typeof setTimeout> | undefined;

  const finish = (exitCode: number | null, error?: string) => {
    if (done) return;
    done = true;
    if (drainTimer) clearTimeout(drainTimer);
    onDone(exitCode, error);
  };

  child.on("error", (err: Error) => finish(null, err.message));
  child.on("close", (code: number | null) => finish(code));
  child.on("exit", (code: number | null) => {
    drainTimer = setTimeout(() => {
      child.stdout?.destroy();
      child.stderr?.destroy();
      finish(code);
    }, EXIT_DRAIN_GRACE_MS);
  });
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/**
 * Run a command to completion and collect its output, capping stdout/stderr
 * independently rather than throwing when a command is chatty. Logs only
 * `cmd` (argv[0]), never `args` or output.
 *
 * `signal` aborts the run: the process group is terminated and the promise
 * resolves with whatever was collected. The daemon uses it to kill a
 * socket's in-flight execs when that socket closes.
 */
export function runExec(
  cmd: string,
  args: string[],
  opts: {
    cwd?: string;
    timeout?: number;
    maxBuffer?: number;
    signal?: AbortSignal;
  } = {},
): Promise<ExecResult> {
  const timeout = normalizeTimeout(opts.timeout);
  const maxBuffer = normalizeMaxBuffer(opts.maxBuffer);

  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnInGroup(cmd, args, { cwd: opts.cwd });
    } catch (err) {
      resolve({
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
        exitCode: null,
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let terminated = false;

    const terminate = () => {
      if (terminated) return;
      terminated = true;
      terminateGroup(child);
    };

    const timer =
      timeout === null
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            terminate();
          }, timeout);

    const onAbort = () => terminate();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts.signal?.aborted) terminate();

    child.stdout?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk: string) => {
      stdout = appendCapped(stdout, chunk, maxBuffer).value;
    });

    child.stderr?.setEncoding("utf-8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = appendCapped(stderr, chunk, maxBuffer).value;
    });

    watchCompletion(child, (exitCode, error) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (error !== undefined) stderr += error;
      resolve({
        stdout,
        stderr: timedOut
          ? stderr + `\n[timed out after ${timeout}ms]`
          : stderr,
        exitCode,
      });
    });
  });
}

interface StreamCallbacks {
  /**
   * Return `false` to signal backpressure: the runner pauses every child's
   * output until `resumeOutput()` is called.
   */
  onStdout: (execId: string, data: string) => boolean | void;
  onStderr: (execId: string, data: string) => boolean | void;
  onExit: (execId: string, exitCode: number | null) => void;
}

interface TrackedChild {
  child: ChildProcess;
  terminated: boolean;
}

/**
 * Tracks the `execId -> child process` map for streaming `execStream`
 * commands, so `execCancel` and stream-socket disconnect can both reach the
 * right child.
 */
export class ExecRunner {
  private children = new Map<string, TrackedChild>();
  /** Set while the consumer is backpressured; children's output is paused. */
  private paused = false;
  /** Set by disposeAll(); no callbacks fire afterwards. */
  private disposed = false;

  /** True if an execId is already running. */
  has(execId: string): boolean {
    return this.children.has(execId);
  }

  start(
    execId: string,
    cmd: string,
    args: string[],
    opts: { cwd?: string; env?: Record<string, string> },
    callbacks: StreamCallbacks,
  ): void {
    if (this.disposed) return;

    if (this.children.has(execId)) {
      // Answer rather than drop: a client waiting on this execId's exit would
      // otherwise hang forever.
      callbacks.onStderr(execId, `execId ${execId} is already running`);
      callbacks.onExit(execId, null);
      return;
    }

    let child: ChildProcess;
    try {
      child = spawnInGroup(cmd, args, opts);
    } catch (err) {
      callbacks.onStderr(
        execId,
        err instanceof Error ? err.message : String(err),
      );
      callbacks.onExit(execId, null);
      return;
    }

    const tracked: TrackedChild = { child, terminated: false };
    this.children.set(execId, tracked);

    const onChunk =
      (emit: StreamCallbacks["onStdout"]) => (chunk: string) => {
        if (this.disposed) return;
        if (emit(execId, chunk) === false) this.pauseOutput();
      };

    child.stdout?.setEncoding("utf-8");
    child.stdout?.on("data", onChunk(callbacks.onStdout));
    child.stderr?.setEncoding("utf-8");
    child.stderr?.on("data", onChunk(callbacks.onStderr));
    if (this.paused) {
      child.stdout?.pause();
      child.stderr?.pause();
    }

    watchCompletion(child, (exitCode, error) => {
      if (this.children.get(execId) === tracked) {
        this.children.delete(execId);
      }
      if (this.disposed) return;
      if (error !== undefined) callbacks.onStderr(execId, error);
      callbacks.onExit(execId, exitCode);
    });
  }

  /** Cancel a running execStream child; a no-op if it already finished. */
  cancel(execId: string): void {
    const tracked = this.children.get(execId);
    if (!tracked) return;
    this.terminate(tracked);
  }

  /** Stop reading every child's output until `resumeOutput()`. */
  pauseOutput(): void {
    if (this.paused) return;
    this.paused = true;
    for (const { child } of this.children.values()) {
      child.stdout?.pause();
      child.stderr?.pause();
    }
  }

  /** Undo `pauseOutput()` — call once the consumer has drained. */
  resumeOutput(): void {
    if (!this.paused) return;
    this.paused = false;
    for (const { child } of this.children.values()) {
      child.stdout?.resume();
      child.stderr?.resume();
    }
  }

  /**
   * Kill every child tracked by this runner (process group, with SIGKILL
   * escalation). Used when the stream socket that started them disconnects,
   * so a dropped ssh connection cannot leak processes. No callbacks fire
   * after this: there is nobody left to deliver them to.
   */
  disposeAll(): void {
    this.disposed = true;
    for (const tracked of this.children.values()) {
      this.terminate(tracked);
      // Keep reading so a child blocked on a full pipe can reach the signal.
      tracked.child.stdout?.resume();
      tracked.child.stderr?.resume();
    }
    this.children.clear();
  }

  private terminate(tracked: TrackedChild): void {
    if (tracked.terminated) return;
    tracked.terminated = true;
    terminateGroup(tracked.child);
  }
}
