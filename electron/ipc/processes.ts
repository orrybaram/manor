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
 * Daemon/process control, whole (ADR-180 ticket 8). `list` was already
 * lifted for the slice-1 bridge table; the rest of this namespace kills
 * something and was deliberately absent from that table. Under D4 that is no
 * longer a reason to hold it back — a `full` device already reaches
 * `POST /processes/kill`-shaped power through the route table (ADR-178 D3) —
 * so every one of these crosses as an ordinary entry, and every one of them
 * is in `MUTATING`.
 */
export function processesList(deps: IpcDeps): unknown {
  const { backend, agentHookServer, webviewServer, portScanner } = deps;
  return listProcesses({ backend, agentHookServer, webviewServer, portScanner });
}

export async function processesKillSession(
  deps: IpcDeps,
  sessionId: string,
): Promise<void> {
  assertString(sessionId, "sessionId");
  const { backend, agentManager, statsStore } = deps;
  const agent = agentManager.getAgentByPaneId(sessionId);
  if (agent) for (const counter of killCounters(agent)) statsStore.record(counter);
  try {
    await backend.pty.kill(sessionId);
  } catch {
    // Daemon unreachable — session is effectively dead
  }
}

export function processesCleanupDead(
  deps: IpcDeps,
): Promise<{ success: boolean }> {
  return cleanupDeadProcesses(deps.backend);
}

export function processesKillDaemon(): Promise<void> {
  return killDaemon();
}

export function processesRestartPortless(): Promise<void> {
  return restartPortless();
}

export function processesKillAll(deps: IpcDeps): Promise<void> {
  const { backend, agentManager, statsStore, portScanner } = deps;
  return killAllProcesses({ backend, agentManager, statsStore, portScanner });
}
