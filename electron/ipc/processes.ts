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

/**
 * The daemon/process status read, lifted for the ADR-178 bridge. Everything
 * else in this module kills something, and none of it is on the bridge.
 */
export function processesList(deps: IpcDeps): unknown {
  const { backend, agentHookServer, webviewServer, portScanner } = deps;
  return listProcesses({ backend, agentHookServer, webviewServer, portScanner });
}

export function register(deps: IpcDeps): void {
  const {
    backend,
    portScanner,
    agentManager,
    statsStore,
  } = deps;

  ipcMain.handle("processes:list", () => processesList(deps));

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
