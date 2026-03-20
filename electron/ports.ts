import { execSync } from "node:child_process";
import os from "node:os";
import type { BrowserWindow } from "electron";

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

  start(window: BrowserWindow): void {
    this.stop();

    this.timer = setInterval(() => {
      const ports = this.scan();
      if (JSON.stringify(ports) !== JSON.stringify(this.lastPorts)) {
        window.webContents.send("ports-changed", ports);
        this.lastPorts = ports;
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

  scanNow(): ActivePort[] {
    return this.scan();
  }

  private scan(): ActivePort[] {
    const uid = process.getuid?.() ?? 0;

    let output: string;
    try {
      output = execSync(
        `/usr/sbin/lsof -a -iTCP -sTCP:LISTEN -nP -F pcn -u ${uid}`,
        { encoding: "utf-8", timeout: 5000 },
      );
    } catch {
      return [];
    }

    const results = this.parseLsofPorts(output);

    if (this.workspacePaths.length > 0 && results.length > 0) {
      const pids = results.map((p) => p.pid);
      const cwds = this.cwdsByPid(pids);
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

  private cwdsByPid(pids: number[]): Map<number, string> {
    if (pids.length === 0) return new Map();

    const pidList = pids.join(",");
    let output: string;
    try {
      output = execSync(`/usr/sbin/lsof -a -p ${pidList} -d cwd -nP -F pn`, {
        encoding: "utf-8",
        timeout: 5000,
      });
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
