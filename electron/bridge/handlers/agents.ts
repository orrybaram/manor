import { getConnector } from "../../agent-connectors";
import { assertString } from "../../ipc-validate";
import {
  getUnseenSnapshot,
  markAgentNotificationsRead,
  sendAgentUpdate,
  updateDockBadge,
} from "../../notifications";
import { killCounters } from "../../stats-signals";
import { cleanAgentTitle } from "../../title-utils";
import type { IpcDeps } from "../../ipc/types";

const ALLOWED_RENDERER_TASK_FIELDS: ReadonlySet<string> = new Set([
  "name",
  "namePinned",
]);

function assertRendererAgentUpdate(updates: unknown): asserts updates is Record<string, unknown> {
  if (!updates || typeof updates !== "object") {
    throw new Error("agents:update: updates must be an object");
  }
  for (const key of Object.keys(updates as object)) {
    if (!ALLOWED_RENDERER_TASK_FIELDS.has(key)) {
      throw new Error(`agents:update: field "${key}" is not writable from renderer`);
    }
  }
  const u = updates as Record<string, unknown>;
  if ("name" in u && u.name !== null && typeof u.name !== "string") {
    throw new Error("agents:update: name must be a string or null");
  }
  if ("namePinned" in u && typeof u.namePinned !== "boolean") {
    throw new Error("agents:update: namePinned must be a boolean");
  }
}

/** What `agents:getAll` narrows its page by. */
export interface AgentQuery {
  projectId?: string;
  status?: string;
  limit?: number;
  offset?: number;
}

/** The pane context `agents:setPaneContext` stores against a paneId. */
export interface PaneContext {
  projectId: string;
  projectName: string;
  workspacePath: string;
  agentCommand: string | null;
}

/**
 * All fifteen methods, lifted out of their `ipcMain.handle` wrappers so a
 * paired `full` device and the desktop renderer call the same code (ADR-180
 * ticket 9). Slice 1 kept the writes below desktop-only; under D4 "check on
 * my agents from anywhere" means none of them stays that way — a browser
 * that could watch an agent but not mark it seen was exactly the
 * read-and-type state this ADR exists to end.
 */
export function agentsGetAll(deps: IpcDeps, opts?: AgentQuery): unknown {
  return deps.agentManager.getAllAgents(opts);
}

export function agentsGet(deps: IpcDeps, agentId: string): unknown {
  assertString(agentId, "agentId");
  return deps.agentManager.getAgentById(agentId);
}

export function agentsGetActive(deps: IpcDeps): unknown {
  return deps.agentManager.getActiveAgents();
}

export function agentsGetRecent(
  deps: IpcDeps,
  opts?: { limit?: number },
): unknown {
  return deps.agentManager.getAllAgents({ limit: opts?.limit ?? 50 });
}

export function agentsGetUnseen(): unknown {
  return getUnseenSnapshot();
}

export function agentsBuildResumeCommand(
  deps: IpcDeps,
  agentId: string,
): string | null {
  assertString(agentId, "agentId");
  const agent = deps.agentManager.getAgentById(agentId);
  if (!agent || !agent.agentCommand) return null;
  return getConnector(agent.agentKind).getResumeCommand(
    agent.agentCommand,
    agent.agentSessionId,
  );
}

/**
 * Records which project/workspace a pane belongs to, so the sidebar's
 * per-pane agent metadata (and a later agent record for that pane) has a
 * project to point at. A write — this is why it is `MUTATING` on the ADR-178
 * bridge (ticket 10), audited by paneId the same way `pty.create` is.
 */
export function agentsSetPaneContext(
  deps: IpcDeps,
  paneId: string,
  context: PaneContext,
): void {
  assertString(paneId, "paneId");
  assertString(context.projectId, "projectId");
  assertString(context.projectName, "projectName");
  assertString(context.workspacePath, "workspacePath");
  deps.paneContextMap.set(paneId, context);
}

/**
 * Returns the count of agents pruned during the most recent AgentManager
 * boot, exactly once per upgrade. After the renderer consumes it, the
 * `agentPruneNoticeShown` flag is set so subsequent boots return 0.
 */
export function agentsConsumePruneNotice(deps: IpcDeps): number {
  const { agentManager, preferencesManager } = deps;
  const count = agentManager.getLastPruneCount();
  if (count <= 0) return 0;
  if (preferencesManager.get("agentPruneNoticeShown")) return 0;
  preferencesManager.set("agentPruneNoticeShown", true);
  return count;
}

/**
 * Renames or (un)pins an agent — the only fields a renderer may touch, per
 * `assertRendererAgentUpdate`. Broadcasts so every consumer of the agent list
 * (sidebar, palette, toasts) sees the new name without a reload.
 */
export function agentsUpdate(
  deps: IpcDeps,
  agentId: string,
  updates: unknown,
): unknown {
  assertString(agentId, "agentId");
  assertRendererAgentUpdate(updates);
  const updated = deps.agentManager.updateAgent(agentId, updates);
  if (updated) {
    sendAgentUpdate(updated, deps.preferencesManager);
  }
  return updated;
}

export function agentsDelete(deps: IpcDeps, agentId: string): boolean {
  assertString(agentId, "agentId");
  const { unseenRespondedAgents, unseenInputAgents, preferencesManager } = deps;
  unseenRespondedAgents.delete(agentId);
  unseenInputAgents.delete(agentId);
  const result = deps.agentManager.deleteAgent(agentId);
  updateDockBadge(preferencesManager);
  return result;
}

/**
 * Clears both unseen Sets for `agentId`, marks its notification-log entries
 * read (ADR-162 §6 — the bell must not keep an indicator up for a session
 * already on screen), and re-broadcasts so the renderer cache reflects the
 * cleared flags. The agent record itself didn't mutate, but `sendAgentUpdate`
 * ships the unseen flags alongside it — this is what keeps main authoritative
 * for pulse state, for a browser marking an agent seen exactly as much as a
 * desktop window doing it (ADR-179 ticket 4's fix for the viewport path
 * applies here too: the same broadcast, whichever caller wrote the Sets).
 */
export function agentsMarkSeen(deps: IpcDeps, agentId: string): void {
  assertString(agentId, "agentId");
  const { unseenRespondedAgents, unseenInputAgents, preferencesManager } = deps;
  unseenRespondedAgents.delete(agentId);
  unseenInputAgents.delete(agentId);
  markAgentNotificationsRead(agentId, deps.mainWindow);
  const agent = deps.agentManager.getAgentById(agentId);
  if (agent) {
    sendAgentUpdate(agent, preferencesManager);
  } else {
    // Agent is gone (deleted before markSeen reached us) — at least refresh
    // the dock badge since the Sets just shrank.
    updateDockBadge(preferencesManager);
  }
}

export function agentsMarkResumed(deps: IpcDeps, agentId: string): unknown {
  assertString(agentId, "agentId");
  return deps.agentManager.updateAgent(agentId, {
    resumedAt: new Date().toISOString(),
  });
}

/**
 * Marks the active agent on `paneId` abandoned — a session end triggered by
 * a pane close rather than by the agent itself. Mirrored by
 * `abandonAgentForClosedPane` in `electron/routes/panes.ts` for a structural
 * close that never touches a renderer.
 */
export function agentsAbandonForPane(
  deps: IpcDeps,
  paneId: string,
  title?: string | null,
): void {
  assertString(paneId, "paneId");
  const { agentManager, statsStore, preferencesManager } = deps;
  const agent = agentManager.getAgentByPaneId(paneId);
  if (!agent || agent.status !== "active") return;
  for (const counter of killCounters(agent)) statsStore.record(counter);
  const nameUpdate = !agent.name && title ? cleanAgentTitle(title) : null;
  const updated = agentManager.updateAgent(agent.id, {
    status: "abandoned",
    completedAt: new Date().toISOString(),
    ...(nameUpdate ? { name: nameUpdate } : {}),
  });
  if (updated) {
    sendAgentUpdate(updated, preferencesManager);
  }
}

/**
 * Sweeps every `active` agent whose pane the daemon no longer has a live
 * session for, and marks it `abandoned` — the desktop's boot-time cleanup
 * for sessions that died while nothing was watching. A `responded` agent is
 * left alone even if its pane is gone: it already has an outcome.
 */
export async function agentsReconcileStale(deps: IpcDeps): Promise<void> {
  const { agentManager, backend, preferencesManager } = deps;
  let liveSessions: Array<{ sessionId: string }>;
  try {
    liveSessions = await backend.pty.listSessions();
  } catch {
    // Daemon unreachable — skip reconciliation
    return;
  }

  const livePaneIds = new Set(liveSessions.map((s) => s.sessionId));
  const allAgents = agentManager.getAllAgents();

  for (const agent of allAgents) {
    if (agent.status !== "active") continue;
    if (!agent.paneId) continue;
    if (livePaneIds.has(agent.paneId)) continue;
    if (agent.lastAgentStatus === "responded") continue;

    const updated = agentManager.updateAgent(agent.id, {
      status: "abandoned",
      completedAt: new Date().toISOString(),
    });
    if (updated) {
      sendAgentUpdate(updated, preferencesManager);
    }
  }
}
