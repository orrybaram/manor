import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { ipcMain, app } from "electron";
import { portlessManager } from "../portless";
import type { IpcDeps } from "./types";
import type { ActivePort } from "../backend/types";

function getDaemonDir(): string {
  const version = app.getVersion();
  return path.join(os.homedir(), ".manor", "daemons", version);
}

function getPidPath(): string {
  return path.join(getDaemonDir(), "terminal-host.pid");
}

function readDaemonPid(): number | null {
  try {
    const content = fs.readFileSync(getPidPath(), "utf-8").trim();
    const pid = parseInt(content, 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

function isDaemonAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function register(deps: IpcDeps): void {
  const { backend, portScanner, agentHookServer, webviewServer } = deps;

  ipcMain.handle("processes:list", async () => {
    const version = app.getVersion();
    const pid = readDaemonPid();
    const alive = pid !== null ? isDaemonAlive(pid) : false;

    const internalServers: Array<{ name: string; port: number | null }> = [
      { name: "agentHookServer", port: agentHookServer.hookPort ?? null },
      { name: "webviewServer", port: webviewServer.serverPort ?? null },
      { name: "portlessManager", port: portlessManager.proxyPort },
    ];

    const sessionList = await backend.pty.listSessions();
    const sessions = sessionList.map((s) => ({
      sessionId: s.sessionId,
      alive: s.alive,
      cwd: s.cwd,
    }));

    const rawPorts = await portScanner.scanNow();
    const ports: ActivePort[] = rawPorts;

    return {
      daemon: { pid, alive, version },
      internalServers,
      sessions,
      ports,
    };
  });

  ipcMain.handle(
    "processes:killSession",
    async (_event, sessionId: string) => {
      await backend.pty.kill(sessionId);
    },
  );

  ipcMain.handle("processes:killDaemon", async () => {
    const pid = readDaemonPid();
    if (pid === null) return;

    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Process may already be dead
    }

    const daemonDir = getDaemonDir();
    const socketPath = path.join(daemonDir, "terminal-host.sock");
    const pidPath = getPidPath();

    try {
      fs.unlinkSync(socketPath);
    } catch {
      // Ignore if already gone
    }
    try {
      fs.unlinkSync(pidPath);
    } catch {
      // Ignore if already gone
    }
  });

  ipcMain.handle("processes:killAll", async () => {
    // 1. List all sessions
    const sessions = await backend.pty.listSessions();

    // 2. Kill each session
    for (const session of sessions) {
      try {
        await backend.pty.kill(session.sessionId);
      } catch {
        // Session may already be dead
      }
    }

    // 3. Kill all workspace-associated ports
    const ports = await portScanner.scanNow();
    for (const port of ports) {
      try {
        await backend.ports.kill(port.pid);
      } catch {
        // Process may already be dead
      }
    }

    // 4. Kill the daemon
    const pid = readDaemonPid();
    if (pid !== null) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Process may already be dead
      }
    }

    // Fire and forget — UI will re-query
  });
}
