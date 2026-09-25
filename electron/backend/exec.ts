import { execFile, spawn } from "node:child_process";
import { readFile as fsReadFile } from "node:fs/promises";
import { promisify } from "node:util";

export const execFileAsync = promisify(execFile);

/**
 * Injectable command-execution surface used by the local git/shell/ports
 * backends. `localExec` runs commands on this machine; a remote
 * implementation can satisfy the same interface by routing through the
 * terminal-host daemon over ssh (see ADR-160).
 */
export interface Exec {
  file(
    cmd: string,
    args: string[],
    opts?: { cwd?: string; timeout?: number; maxBuffer?: number },
  ): Promise<{ stdout: string; stderr: string }>;
  stream(
    cmd: string,
    args: string[],
    opts: { cwd?: string; env?: NodeJS.ProcessEnv },
    cb: {
      onStdout?: (chunk: string) => void;
      onStderr?: (chunk: string) => void;
      onExit: (result: { exitCode: number | null }) => void;
    },
  ): { cancel: () => void };
  readFile(path: string, encoding: "utf-8"): Promise<string>;
}

export const localExec: Exec = {
  async file(cmd, args, opts) {
    return execFileAsync(cmd, args, {
      cwd: opts?.cwd,
      timeout: opts?.timeout,
      maxBuffer: opts?.maxBuffer,
    });
  },

  stream(cmd, args, opts, cb) {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
    });

    let exited = false;

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
      cb.onStderr?.(err.message);
      cb.onExit({ exitCode: null });
    });

    child.on("close", (code: number | null) => {
      if (exited) return;
      exited = true;
      cb.onExit({ exitCode: code });
    });

    return {
      cancel: () => {
        if (exited) return;
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
