import { ipcMain } from "electron";
import { assertString } from "../ipc-validate";
import { killCounters } from "../stats-signals";
import type { IpcDeps } from "./types";
import {
  listProcesses,
  cleanupDeadProcesses,
  killDaemon,
  restartPortless,
  killAllProcesses,
} from "../process-control";

export function register(deps: IpcDeps): void {
  const {
    backend,
    portScanner,
    agentHookServer,
    webviewServer,
    agentManager,
    statsStore,
  } = deps;

  ipcMain.handle("processes:list", () =>
    listProcesses({ backend, agentHookServer, webviewServer, portScanner }),
  );

  ipcMain.handle("processes:killSession", async (_event, sessionId: string) => {
    assertString(sessionId, "sessionId");
    const agent = agentManager.getAgentByPaneId(sessionId);
    if (agent) for (const counter of killCounters(agent)) statsStore.record(counter);
    try {
      await backend.pty.kill(sessionId);
    } catch {
      // Daemon unreachable — session is effectively dead
    }
  });

  ipcMain.handle("processes:cleanupDead", () => cleanupDeadProcesses(backend));

  ipcMain.handle("processes:killDaemon", () => killDaemon());

  ipcMain.handle("processes:restartPortless", () => restartPortless());

  ipcMain.handle("processes:killAll", () =>
    killAllProcesses({ backend, agentManager, statsStore, portScanner }),
  );
}
