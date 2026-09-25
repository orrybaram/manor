import type { ShellBackend } from "./types";
import { localExec, type Exec } from "./exec";

export class LocalShellBackend implements ShellBackend {
  constructor(private readonly execImpl: Exec = localExec) {}

  async which(bin: string): Promise<string | null> {
    try {
      const { stdout } = await this.execImpl.file("which", [bin]);
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
    const { stdout } = await this.execImpl.file(cmd, args, {
      cwd: opts?.cwd,
      timeout: opts?.timeout,
    });
    return stdout;
  }
}
