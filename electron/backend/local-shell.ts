import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ShellBackend } from "./types";

const execFileAsync = promisify(execFile);

export class LocalShellBackend implements ShellBackend {
  async which(bin: string): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync("which", [bin]);
      const result = stdout.trim();
      return result.length > 0 ? result : null;
    } catch {
      return null;
    }
  }

  async exec(
    command: string,
    opts?: { cwd?: string; timeout?: number },
  ): Promise<string> {
    const [cmd, ...args] = command.split(" ");
    const { stdout } = await execFileAsync(cmd, args, {
      cwd: opts?.cwd,
      timeout: opts?.timeout,
    });
    return stdout;
  }
}
