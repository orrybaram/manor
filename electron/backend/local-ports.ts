import os from "node:os";
import type { ActivePort, PortsBackend } from "./types";
import { localExec, type Exec } from "./exec";

/**
 * Facts about the machine being scanned that are not commands. Split out so
 * a remote host answers them about *its* machine: the uid whose listeners
 * count, the home directory never attributed to a workspace, and how to
 * signal a pid (a pid from a remote scan must never be killed locally).
 */
export interface PortsHost {
  uid(): Promise<number>;
  homeDir(): Promise<string>;
  kill(pid: number): Promise<void>;
}

const localPortsHost: PortsHost = {
  async uid() {
    return process.getuid?.() ?? 0;
  },
  async homeDir() {
    return os.homedir();
  },
  async kill(pid) {
    process.kill(pid, "SIGTERM");
  },
};

/**
 * A `PortsHost` answered through an `Exec` — for a machine this process is
 * not running on. `uid` and `homeDir` are asked once and cached.
 */
export function execPortsHost(execImpl: Exec): PortsHost {
  let uid: Promise<number> | null = null;
  let home: Promise<string> | null = null;
  return {
    uid() {
      uid ??= execImpl.file("id", ["-u"], { timeout: 5000 }).then(
        ({ stdout }) => parseInt(stdout.trim(), 10) || 0,
        (err: unknown) => {
          uid = null; // retry next scan
          throw err;
        },
      );
      return uid;
    },
    homeDir() {
      home ??= execImpl
        .file("printenv", ["HOME"], { timeout: 5000 })
        .then(
          ({ stdout }) => stdout.trim(),
          (err: unknown) => {
            home = null;
            throw err;
          },
        );
      return home;
    },
    async kill(pid) {
      await execImpl.file("kill", ["-TERM", String(pid)], { timeout: 5000 });
    },
  };
}

export class LocalPortsBackend implements PortsBackend {
  constructor(
    private readonly execImpl: Exec = localExec,
    private readonly host: PortsHost = localPortsHost,
  ) {}

  async scan(workspacePaths: string[]): Promise<ActivePort[]> {
    let uid: number;
    try {
      uid = await this.host.uid();
    } catch {
      return [];
    }

    let output: string;
    try {
      const { stdout } = await this.execImpl.file(
        "/usr/sbin/lsof",
        ["-a", "-iTCP", "-sTCP:LISTEN", "-nP", "-F", "pcn", "-u", String(uid)],
        { timeout: 5000 },
      );
      output = stdout;
    } catch {
      return [];
    }

    const results = this.parseLsofPorts(output);

    if (workspacePaths.length > 0 && results.length > 0) {
      const pids = results.map((p) => p.pid);
      const cwds = await this.cwdsByPid(pids);
      const home = await this.host.homeDir().catch(() => null);

      for (const port of results) {
        const cwd = cwds.get(port.pid);
        if (cwd) {
          const best = workspacePaths
            .filter((ws) => cwd.startsWith(ws))
            .sort((a, b) => b.length - a.length)[0];
          if (best && best !== home) {
            port.workspacePath = best;
          }
        }
      }
    }

    return results
      .filter((p) => p.workspacePath !== null)
      .sort((a, b) => a.port - b.port);
  }

  async kill(pid: number): Promise<void> {
    await this.host.kill(pid);
  }

  private parseLsofPorts(output: string): ActivePort[] {
    const results: ActivePort[] = [];
    const seenPorts = new Set<number>();
    let currentPid = 0;
    let currentCmd = "";

    for (const line of output.split("\n")) {
      if (!line) continue;
      const prefix = line[0];
      const value = line.slice(1);

      switch (prefix) {
        case "p":
          currentPid = parseInt(value, 10) || 0;
          break;
        case "c":
          currentCmd = value;
          break;
        case "n": {
          const colonIdx = value.lastIndexOf(":");
          if (colonIdx >= 0) {
            const port = parseInt(value.slice(colonIdx + 1), 10);
            if (!isNaN(port) && !seenPorts.has(port)) {
              seenPorts.add(port);
              results.push({
                port,
                processName: currentCmd,
                pid: currentPid,
                workspacePath: null,
                hostname: null,
              });
            }
          }
          break;
        }
      }
    }

    return results;
  }

  private async cwdsByPid(pids: number[]): Promise<Map<number, string>> {
    if (pids.length === 0) return new Map();

    const pidList = pids.join(",");
    let output: string;
    try {
      const { stdout } = await this.execImpl.file(
        "/usr/sbin/lsof",
        ["-a", "-p", pidList, "-d", "cwd", "-nP", "-F", "pn"],
        { timeout: 5000 },
      );
      output = stdout;
    } catch {
      return new Map();
    }

    const result = new Map<number, string>();
    let currentPid = 0;

    for (const line of output.split("\n")) {
      if (!line) continue;
      const prefix = line[0];
      const value = line.slice(1);

      if (prefix === "p") {
        currentPid = parseInt(value, 10) || 0;
      } else if (prefix === "n" && currentPid !== 0) {
        result.set(currentPid, value);
      }
    }

    return result;
  }
}
