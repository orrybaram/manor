import type { ShellBackend } from "./types";
import { execFileAsync } from "./exec";

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
    cmd: string,
    args: string[],
    opts?: { cwd?: string; timeout?: number },
  ): Promise<string> {
    const { stdout } = await execFileAsync(cmd, args, {
      cwd: opts?.cwd,
      timeout: opts?.timeout,
    });
    return stdout;
  }
}
