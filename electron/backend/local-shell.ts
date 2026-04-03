import type { ShellBackend } from "./types";

export class LocalShellBackend implements ShellBackend {
  async which(_bin: string): Promise<string | null> {
    throw new Error("Not implemented");
  }

  async exec(
    _command: string,
    _opts?: { cwd?: string; timeout?: number },
  ): Promise<string> {
    throw new Error("Not implemented");
  }
}
