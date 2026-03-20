import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import type { BrowserWindow } from "electron";

const execFileAsync = promisify(execFile);

interface ActivePort {
  port: number;
  processName: string;
  pid: number;
  workspacePath: string | null;
}

export class PortScanner {
  private workspacePaths: string[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastPorts: ActivePort[] = [];
  private scanning = false;

  start(window: BrowserWindow): void {
    this.stop();

    this.timer = setInterval(async () => {
      if (this.scanning) return;
      this.scanning = true;
      try {
        const ports = await this.scan();
        if (JSON.stringify(ports) !== JSON.stringify(this.lastPorts)) {
          window.webContents.send("ports-changed", ports);
          this.lastPorts = ports;
        }
      } finally {
        this.scanning = false;
      }
    }, 3000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  updateWorkspacePaths(paths: string[]): void {
    this.workspacePaths = paths;
  }

  async scanNow(): Promise<ActivePort[]> {
    return this.scan();
  }

  private async scan(): Promise<ActivePort[]> {
    const uid = process.getuid?.() ?? 0;

    let output: string;
    try {
      const { stdout } = await execFileAsync(
        "/usr/sbin/lsof",
        ["-a", "-iTCP", "-sTCP:LISTEN", "-nP", "-F", "pcn", "-u", String(uid)],
        { timeout: 5000 },
      );
      output = stdout;
    } catch {
      return [];
    }

    const results = this.parseLsofPorts(output);

    if (this.workspacePaths.length > 0 && results.length > 0) {
      const pids = results.map((p) => p.pid);
      const cwds = await this.cwdsByPid(pids);
      const home = os.homedir();

      for (const port of results) {
        const cwd = cwds.get(port.pid);
        if (cwd) {
          const best = this.workspacePaths
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
      const { stdout } = await execFileAsync(
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
