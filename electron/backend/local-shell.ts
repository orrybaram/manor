import os from "node:os";
import type { ShellBackend } from "./types";
import { localExec, type Exec } from "./exec";

/**
 * Facts about the machine a `LocalShellBackend` runs on that are not
 * commands — split out the same way `PortsHost` is (see `local-ports.ts`),
 * so a remote host answers `homeDir` about *its* machine instead of this
 * one.
 */
export interface ShellHost {
  homeDir(): Promise<string>;
}

const localShellHost: ShellHost = {
  async homeDir() {
    return os.homedir();
  },
};

/**
 * A `ShellHost` answered through an `Exec` — for a machine this process is
 * not running on. `homeDir` is asked once per host and cached.
 */
export function execShellHost(execImpl: Exec): ShellHost {
  let home: Promise<string> | null = null;
  return {
    homeDir() {
      home ??= execImpl.file("sh", ["-c", 'printf %s "$HOME"']).then(
        ({ stdout }) => stdout.trim(),
        (err: unknown) => {
          home = null; // retry next call
          throw err;
        },
      );
      return home;
    },
  };
}

export class LocalShellBackend implements ShellBackend {
  constructor(
    private readonly execImpl: Exec = localExec,
    private readonly host: ShellHost = localShellHost,
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

  async homeDir(): Promise<string> {
    return this.host.homeDir();
  }
}
