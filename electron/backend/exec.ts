import { execFile, spawn } from "node:child_process";
import { readFile as fsReadFile } from "node:fs/promises";
import { promisify } from "node:util";

export const execFileAsync = promisify(execFile);

/**
 * The shape `Exec.file` rejects with when a command fails (non-zero exit,
 * spawn failure, timeout, or output past `maxBuffer`). This is what Node's
 * `execFile` rejects with, and callers depend on it — `parseCommitError` in
 * `local-git.ts` reads `stderr`/`stdout` off the rejection to explain a
 * failed commit hook. Any non-local `Exec` (e.g. one routed through the
 * terminal-host daemon) must reject with an `Error` carrying these fields.
 */
export interface ExecError extends Error {
  /** Output collected before the failure; `""` when there was none. */
  stdout: string;
  stderr: string;
  /**
   * The exit code for a command that ran and exited non-zero, an errno string
   * (e.g. `"ENOENT"`) when it could not be spawned, or `null` when it was
   * killed by a signal (including a timeout).
   */
  code: number | string | null;
}

/**
 * Injectable command-execution surface used by the local git/shell/ports
 * backends. `localExec` runs commands on this machine; a remote
 * implementation can satisfy the same interface by routing through the
 * terminal-host daemon over ssh (see ADR-160).
 */
export interface Exec {
  /**
   * Run a command to completion. Resolves with its output on exit code 0;
   * otherwise rejects with an {@link ExecError}. Omitted options keep the
   * implementation's defaults (for `localExec`, Node's `execFile` defaults:
   * no timeout and a 1 MiB `maxBuffer`).
   */
  file(
    cmd: string,
    args: string[],
    opts?: { cwd?: string; timeout?: number; maxBuffer?: number },
  ): Promise<{ stdout: string; stderr: string }>;
  /**
   * Spawn a command and stream its output. `env` holds *overrides* merged
   * onto the implementation's own base environment (for `localExec`,
   * `process.env`; for a remote implementation, the remote daemon's) — never
   * a full environment, since the caller's environment is not the one the
   * command runs in.
   *
   * `onExit` fires exactly once. When the command could not be run at all,
   * `exitCode` is `null` and `error` carries the reason; that reason is *not*
   * also delivered through `onStderr`.
   */
  stream(
    cmd: string,
    args: string[],
    opts: { cwd?: string; env?: Record<string, string> },
    cb: {
      onStdout?: (chunk: string) => void;
      onStderr?: (chunk: string) => void;
      onExit: (result: { exitCode: number | null; error?: string }) => void;
    },
  ): { cancel: () => void };
  readFile(path: string, encoding: "utf-8"): Promise<string>;
}

export const localExec: Exec = {
  async file(cmd, args, opts) {
    // Only forward options the caller actually set: an explicit `undefined`
    // overrides execFile's defaults (e.g. `maxBuffer: undefined` disables the
    // 1 MiB cap entirely instead of keeping it).
    const execOpts: { cwd?: string; timeout?: number; maxBuffer?: number } =
      {};
    if (opts?.cwd !== undefined) execOpts.cwd = opts.cwd;
    if (opts?.timeout !== undefined) execOpts.timeout = opts.timeout;
    if (opts?.maxBuffer !== undefined) execOpts.maxBuffer = opts.maxBuffer;
    return execFileAsync(cmd, args, execOpts);
  },

  stream(cmd, args, opts, cb) {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
    });

    let exited = false;
    let killed = false;

    if (child.stdout && cb.onStdout) {
      child.stdout.setEncoding("utf-8");
      child.stdout.on("data", (chunk: string) => cb.onStdout?.(chunk));
    }

    if (child.stderr && cb.onStderr) {
      child.stderr.setEncoding("utf-8");
      child.stderr.on("data", (chunk: string) => cb.onStderr?.(chunk));
    }

    child.on("error", (err: Error) => {
      if (exited) return;
      exited = true;
      cb.onExit({ exitCode: null, error: err.message });
    });

    child.on("close", (code: number | null) => {
      if (exited) return;
      exited = true;
      cb.onExit({ exitCode: code });
    });

    return {
      cancel: () => {
        if (exited || killed) return;
        killed = true;
        try {
          child.kill("SIGTERM");
        } catch {
          /* already exited or signal failed — caller does not care */
        }
      },
    };
  },

  async readFile(path, encoding) {
    return fsReadFile(path, encoding);
  },
};
