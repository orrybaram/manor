import { ipcMain } from "electron";
import { getConnector } from "../agent-connectors";
import { assertString } from "../ipc-validate";
import {
  getUnseenSnapshot,
  markAgentNotificationsRead,
  sendAgentUpdate,
  updateDockBadge,
} from "../notifications";
import { killCounters } from "../stats-signals";
import { cleanAgentTitle } from "../title-utils";
import { agentHostId, type AgentInfo } from "../agent-persistence";
import { paneContextBackfill } from "../agent-status/effects";
import { LOCAL_HOST_ID } from "../backend/types";
import type { IpcDeps } from "./types";

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

/** Whether the host an agent's terminal runs on is connected (local always is). */
function isAgentHostConnected(
  deps: IpcDeps,
  agent: Pick<AgentInfo, "paneId" | "hostId">,
): boolean {
  const hostId = agentHostId(agent, deps.getPaneHostId);
  return hostId === LOCAL_HOST_ID || deps.backendRegistry.status(hostId) === "connected";
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
 * The reads, lifted out of their `ipcMain.handle` wrappers so the ADR-178
 * WebSocket bridge calls the same code the desktop renderer does. Everything
 * that mutates an agent record — update, delete, markSeen, abandonForPane,
 * reconcileStale — stays desktop-only for slice 1.
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

/** Every pane's currently published Agent status (ADR-184 ticket 5). */
export function agentsGetPaneStatuses(deps: IpcDeps): unknown {
  return deps.agentStatus.getAllPaneStatuses();
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
  // An Agent created before this call (a live session's hooks after a
  // restart) has no project; fill it in now that the pane's is known.
  const agent = deps.agentManager.getAgentByPaneId(paneId);
  const backfill = agent ? paneContextBackfill(agent, context) : null;
  const updated = agent && backfill ? deps.agentManager.updateAgent(agent.id, backfill) : null;
  if (updated) sendAgentUpdate(deps.mainWindow, updated, deps.preferencesManager);
}

export function register(deps: IpcDeps): void {
  const {
    agentManager,
    unseenRespondedAgents,
    unseenInputAgents,
    preferencesManager,
    backend,
    statsStore,
    agentStatus,
  } = deps;

  ipcMain.handle("agents:getAll", (_event, opts?: AgentQuery) =>
    agentsGetAll(deps, opts),
  );

  ipcMain.handle("agents:get", (_event, agentId: string) =>
    agentsGet(deps, agentId),
  );

  ipcMain.handle("agents:getActive", () => agentsGetActive(deps));

  ipcMain.handle("agents:getRecent", (_event, opts?: { limit?: number }) =>
    agentsGetRecent(deps, opts),
  );

  /**
   * Returns the full unseen-flag snapshot from main as `{ responded, requires_input }`
   * arrays of agent ids. Used by the renderer on boot to prime its cache so
   * the pulse-state matches main exactly. See ADR-136 §"Change 3".
   */
  ipcMain.handle("agents:getUnseen", () => agentsGetUnseen());

  /**
   * Returns the count of agents pruned during the most recent AgentManager
   * boot, exactly once per upgrade. After the renderer consumes it, the
   * `agentPruneNoticeShown` flag is set so subsequent boots return 0.
   */
  ipcMain.handle("agents:consumePruneNotice", () => {
    const count = agentManager.getLastPruneCount();
    if (count <= 0) return 0;
    if (preferencesManager.get("agentPruneNoticeShown")) return 0;
    preferencesManager.set("agentPruneNoticeShown", true);
    return count;
  });

  ipcMain.handle(
    "agents:update",
    (_event, agentId: string, updates: unknown) => {
      assertString(agentId, "agentId");
      assertRendererAgentUpdate(updates);
      const updated = agentManager.updateAgent(agentId, updates);
      // Broadcast so every consumer of the agent list (sidebar, palette,
      // toasts) sees the new name without a reload.
      if (updated) {
        sendAgentUpdate(deps.mainWindow, updated, preferencesManager);
      }
      return updated;
    },
  );

  ipcMain.handle("agents:delete", (_event, agentId: string) => {
    assertString(agentId, "agentId");
    unseenRespondedAgents.delete(agentId);
    unseenInputAgents.delete(agentId);
    const result = agentManager.deleteAgent(agentId);
    updateDockBadge(preferencesManager);
    return result;
  });

  ipcMain.handle("agents:markSeen", (_event, agentId: string) => {
    assertString(agentId, "agentId");
    unseenRespondedAgents.delete(agentId);
    unseenInputAgents.delete(agentId);
    // Seeing the pane also reads the log entries about it (ADR-162 §6): the
    // bell must not keep an indicator up for a session on screen.
    markAgentNotificationsRead(agentId, deps.mainWindow);
    // Re-broadcast so the renderer cache reflects the cleared flags. The agent
    // itself didn't mutate, but `sendAgentUpdate` ships the unseen flags
    // alongside it — this is what keeps main authoritative for pulse state.
    const agent = agentManager.getAgentById(agentId);
    if (agent) {
      sendAgentUpdate(deps.mainWindow, agent, preferencesManager);
    } else {
      // Agent is gone (deleted before markSeen reached us) — at least refresh
      // the dock badge since the Sets just shrank.
      updateDockBadge(preferencesManager);
    }
  });

  ipcMain.handle("agents:markResumed", (_event, agentId: string) => {
    assertString(agentId, "agentId");
    return agentManager.updateAgent(agentId, {
      resumedAt: new Date().toISOString(),
    });
  });

  ipcMain.handle("agents:buildResumeCommand", (_event, agentId: string) =>
    agentsBuildResumeCommand(deps, agentId),
  );

  ipcMain.handle(
    "agents:setPaneContext",
    (_event, paneId: string, context: PaneContext) =>
      agentsSetPaneContext(deps, paneId, context),
  );

  ipcMain.handle("agents:abandonForPane", (_event, paneId: string, title?: string | null) => {
    assertString(paneId, "paneId");
    const agent = agentManager.getAgentByPaneId(paneId);
    if (!agent || agent.status !== "active") return;
    for (const counter of killCounters(agent)) statsStore.record(counter);
    // The name is not status: it stays here. It is written before the signal
    // so the reconciler's broadcast carries it.
    const nameUpdate = !agent.name && title ? cleanAgentTitle(title) : null;
    const named = nameUpdate ? agentManager.updateAgent(agent.id, { name: nameUpdate }) : null;
    // The lifecycle is the Status reconciler's to write (ADR-184): it moves
    // the Agent to 'abandoned', broadcasts it, and resets the pane's status.
    const result = agentStatus.signal(paneId, { type: "user", action: "abandon" });
    const persisted = result.effects.some(
      (e) => e.kind === "PersistAgentStatus" && e.sessionId === agent.agentSessionId,
    );
    // If the reconciler abandoned some other Agent, the rename still has to
    // reach the renderer.
    if (named && !persisted) {
      sendAgentUpdate(deps.mainWindow, named, preferencesManager);
    }
  });

  /**
   * Every pane's currently published Agent status (ADR-184 ticket 5). Called
   * once on renderer startup — including a detached/popout window, or a
   * reload — so it paints current dots instead of waiting on the next signal.
   */
  ipcMain.handle("agents:getPaneStatuses", () => agentsGetPaneStatuses(deps));

  ipcMain.handle("agents:reconcileStale", async () => {
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
      // Sessions of a remote host that is not connected are missing from
      // `listSessions` because nobody could ask, not because they ended.
      if (!isAgentHostConnected(deps, agent)) continue;
      if (agent.lastAgentStatus === "responded") continue;
      // Its pty was killed by a daemon replacement (ADR-185 §A): the pane is
      // about to be cold-restored, which resumes the Agent. Abandoning it
      // here would race that resume and win.
      if (agentStatus.isPaneLossExpected(agent.paneId)) continue;

      // Its pane is gone: the same `user` signal as closing it (ADR-184).
      agentStatus.signal(agent.paneId, { type: "user", action: "abandon" });
    }
  });
}
