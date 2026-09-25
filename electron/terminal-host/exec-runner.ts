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
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

/** Matches `LocalGitBackend.execGit`'s default. */
export const DEFAULT_EXEC_TIMEOUT_MS = 30000;

/** Output cap applied independently to stdout and stderr. */
export const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;

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

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/**
 * Run a command to completion and collect its output, capping stdout/stderr
 * independently rather than throwing when a command is chatty. Logs only
 * `cmd` (argv[0]), never `args` or output.
 */
export function runExec(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeout?: number; maxBuffer?: number } = {},
): Promise<ExecResult> {
  const timeout = opts.timeout ?? DEFAULT_EXEC_TIMEOUT_MS;
  const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER;

  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(cmd, args, { cwd: opts.cwd, shell: false });
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
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        /* already exited */
      }
    }, timeout);

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout,
        stderr: timedOut
          ? stderr + `\n[timed out after ${timeout}ms]`
          : stderr,
        exitCode,
      });
    };

    child.stdout?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk: string) => {
      stdout = appendCapped(stdout, chunk, maxBuffer).value;
    });

    child.stderr?.setEncoding("utf-8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = appendCapped(stderr, chunk, maxBuffer).value;
    });

    child.on("error", (err: Error) => {
      stderr += err.message;
      finish(null);
    });

    child.on("close", (code: number | null) => {
      finish(code);
    });
  });
}

interface StreamCallbacks {
  onStdout: (execId: string, data: string) => void;
  onStderr: (execId: string, data: string) => void;
  onExit: (execId: string, exitCode: number | null) => void;
}

/**
 * Tracks the `execId -> child process` map for streaming `execStream`
 * commands, so `execCancel` and stream-socket disconnect can both reach the
 * right child.
 */
export class ExecRunner {
  private children = new Map<string, ChildProcess>();

  /** True if an execId is already running (start() ignores duplicates). */
  has(execId: string): boolean {
    return this.children.has(execId);
  }

  start(
    execId: string,
    cmd: string,
    args: string[],
    opts: { cwd?: string },
    callbacks: StreamCallbacks,
  ): void {
    if (this.children.has(execId)) return;

    let child: ChildProcess;
    try {
      child = spawn(cmd, args, { cwd: opts.cwd, shell: false });
    } catch (err) {
      callbacks.onStderr(
        execId,
        err instanceof Error ? err.message : String(err),
      );
      callbacks.onExit(execId, null);
      return;
    }

    this.children.set(execId, child);
    let exited = false;

    child.stdout?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk: string) => {
      callbacks.onStdout(execId, chunk);
    });

    child.stderr?.setEncoding("utf-8");
    child.stderr?.on("data", (chunk: string) => {
      callbacks.onStderr(execId, chunk);
    });

    child.on("error", (err: Error) => {
      if (exited) return;
      exited = true;
      this.children.delete(execId);
      callbacks.onStderr(execId, err.message);
      callbacks.onExit(execId, null);
    });

    child.on("close", (code: number | null) => {
      if (exited) return;
      exited = true;
      this.children.delete(execId);
      callbacks.onExit(execId, code);
    });
  }

  /** Cancel a running execStream child; a no-op if it already finished. */
  cancel(execId: string): void {
    const child = this.children.get(execId);
    if (!child) return;
    try {
      child.kill("SIGTERM");
    } catch {
      /* already exited or signal failed — caller does not care */
    }
  }

  /**
   * Kill every child tracked by this runner. Used when the stream socket
   * that started them disconnects, so a dropped ssh connection cannot leak
   * processes.
   */
  disposeAll(): void {
    for (const child of this.children.values()) {
      try {
        child.kill("SIGTERM");
      } catch {
        /* already exited or signal failed — caller does not care */
      }
    }
    this.children.clear();
  }
}
