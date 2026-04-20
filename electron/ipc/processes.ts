import * as fs from "node:fs";
import { ipcMain } from "electron";
import { portlessManager } from "../portless";
import { assertString } from "../ipc-validate";
import type { IpcDeps } from "./types";
import type { ActivePort } from "../backend/types";
import { LayoutPersistence } from "../terminal-host/layout-persistence";
import { daemonPidFile, daemonSocketFile } from "../paths";

function getPidPath(): string {
  return daemonPidFile();
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
    const pid = readDaemonPid();
    const alive = pid !== null ? isDaemonAlive(pid) : false;

    const internalServers: Array<{ name: string; port: number | null }> = [
      { name: "agentHookServer", port: agentHookServer.hookPort ?? null },
      { name: "webviewServer", port: webviewServer.serverPort ?? null },
      { name: "portlessManager", port: portlessManager.proxyPort },
    ];

    // Get the set of session IDs that are referenced by active layout panes.
    // Sessions alive in the daemon but NOT in this set are "orphaned" — their
    // pane was closed or lost, but the processes inside are still running.
    const activeLayoutSessionIds = new LayoutPersistence().getActiveSessionIds();

    let sessions: Array<{ sessionId: string; alive: boolean; cwd: string | null; orphaned: boolean }> = [];
    if (alive) {
      try {
        const sessionList = await backend.pty.listSessions();
        sessions = sessionList.map((s) => ({
          sessionId: s.sessionId,
          alive: s.alive,
          cwd: s.cwd,
          orphaned: !activeLayoutSessionIds.has(s.sessionId),
        }));
      } catch {
        // Daemon unreachable — return empty session list
      }
    }

    const rawPorts = await portScanner.scanNow();
    const ports: ActivePort[] = rawPorts;

    return {
      daemon: { pid, alive },
      internalServers,
      sessions,
      ports,
    };
  });

  ipcMain.handle(
    "processes:killSession",
    async (_event, sessionId: string) => {
      assertString(sessionId, "sessionId");
      try {
        await backend.pty.kill(sessionId);
      } catch {
        // Daemon unreachable — session is effectively dead
      }
    },
  );

  ipcMain.handle("processes:cleanupDead", async (): Promise<{ success: boolean }> => {
    try {
      await backend.pty.disposeDead();
      return { success: true };
    } catch {
      return { success: false };
    }
  });

  ipcMain.handle("processes:killDaemon", async () => {
    const pid = readDaemonPid();
    if (pid === null) return;

    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Process may already be dead
    }

    try { fs.unlinkSync(daemonSocketFile()); } catch { /* already gone */ }
    try { fs.unlinkSync(getPidPath()); } catch { /* already gone */ }
  });

  ipcMain.handle("processes:restartPortless", async () => {
    await portlessManager.restart();
  });

  ipcMain.handle("processes:killAll", async () => {
    // 1. Try to list and kill sessions via daemon (may be unreachable)
    try {
      const sessions = await backend.pty.listSessions();
      for (const session of sessions) {
        try {
          await backend.pty.kill(session.sessionId);
        } catch {
          // Session may already be dead
        }
      }
    } catch {
      // Daemon unreachable — skip session cleanup, will kill daemon by PID below
    }

    // 2. Kill all workspace-associated ports
    try {
      const ports = await portScanner.scanNow();
      for (const port of ports) {
        try {
          await backend.ports.kill(port.pid);
        } catch {
          // Process may already be dead
        }
      }
    } catch {
      // Port scan failed — continue to daemon kill
    }

    // 3. Kill the daemon by PID (works even if socket is dead)
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
