import { assertString } from "../../ipc-validate";
import { killCounters } from "../../stats-signals";
import { method, type HandlerCtx } from "../method";
import {
  type ProcessesSnapshot,
  listProcesses,
  cleanupDeadProcesses,
  killDaemon,
  restartPortless,
  killAllProcesses,
} from "../../process-control";

/**
 * Daemon/process control, whole (ADR-180 ticket 8), as the `processes`
 * namespace of the handler table. Everything but `list` kills something, is
 * reachable by a `full` device on the bridge and nowhere else (ADR-182 D2),
 * and is `mutating`.
 */
export function processesList(ctx: HandlerCtx): Promise<ProcessesSnapshot> {
  const { backend, agentHookServer, webviewServer, portScanner } = ctx.deps;
  return listProcesses({ backend, agentHookServer, webviewServer, portScanner });
}

export async function processesKillSession(
  ctx: HandlerCtx,
  sessionId: string,
): Promise<void> {
  assertString(sessionId, "sessionId");
  const { backend, agentManager, statsStore } = ctx.deps;
  const agent = agentManager.getAgentByPaneId(sessionId);
  if (agent) for (const counter of killCounters(agent)) statsStore.record(counter);
  try {
    await backend.pty.kill(sessionId);
  } catch {
    // Daemon unreachable — session is effectively dead
  }
}

export function processesCleanupDead(
  ctx: HandlerCtx,
): Promise<{ success: boolean }> {
  return cleanupDeadProcesses(ctx.deps.backend);
}

export function processesKillDaemon(): Promise<void> {
  return killDaemon();
}

export function processesRestartPortless(): Promise<void> {
  return restartPortless();
}

export function processesKillAll(ctx: HandlerCtx): Promise<void> {
  const { backend, agentManager, statsStore, portScanner } = ctx.deps;
  return killAllProcesses({ backend, agentManager, statsStore, portScanner });
}

// A session, the daemon or the portless proxy dying is exactly "moves state
// the other viewers of this host will see". `cleanupDead` changes what the
// process list shows next.
export const processes = {
  list: method(processesList),
  killSession: method(processesKillSession, { mutating: true }),
  cleanupDead: method(processesCleanupDead, { mutating: true }),
  killDaemon: method(processesKillDaemon, { mutating: true }),
  restartPortless: method(processesRestartPortless, { mutating: true }),
  killAll: method(processesKillAll, { mutating: true }),
};
