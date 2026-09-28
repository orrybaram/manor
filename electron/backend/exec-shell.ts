import type { ShellBackend } from "./types";
import { localExec, type Exec } from "./exec";
import { localFacts, type MachineFacts } from "./machine-facts";

/**
 * Shell commands run through an `Exec`, on whichever machine that reaches
 * (ADR-183). Facts about the machine, such as its home directory, come from
 * its `MachineFacts`, so a remote host answers about *its* machine.
 */
export class ExecShellBackend implements ShellBackend {
  constructor(
    private readonly execImpl: Exec = localExec,
    private readonly facts: MachineFacts = localFacts(),
  ) {}

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

  /** The machine's home directory (see `MachineFacts.homeDir`). */
  async homeDir(): Promise<string> {
    return this.facts.homeDir();
  }

  /** Write a file on the machine (see `Exec.writeFile`). */
  async writeFile(path: string, data: Buffer): Promise<void> {
    return this.execImpl.writeFile(path, data);
  }
}
