import { getConnector } from "../../agent-connectors";
import type { AgentInfo } from "../../agent-persistence";
import { assertString } from "../../ipc-validate";
import {
  getUnseenSnapshot,
  markAgentNotificationsRead,
  sendAgentUpdate,
  updateDockBadge,
} from "../../notifications";
import { killCounters } from "../../stats-signals";
import { cleanAgentTitle } from "../../title-utils";
import type { AgentService, EndedPane } from "../../layout/layout-store";
import { method, type HandlerCtx } from "../method";

const ALLOWED_RENDERER_TASK_FIELDS: ReadonlySet<string> = new Set([
  "name",
  "namePinned",
]);

/** What a renderer may change about an agent: its name, and whether it is pinned. */
export interface RendererAgentUpdate {
  name?: string | null;
  namePinned?: boolean;
}

function assertRendererAgentUpdate(updates: unknown): asserts updates is RendererAgentUpdate {
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
 * The `agents` namespace of the handler table (ADR-180 ticket 9). "Check on
 * my agents from anywhere" is the sentence ADR-178 started from, so none of
 * it is local-only — a browser that could watch an agent but not mark it
 * seen was exactly the read-and-type state this ADR exists to end.
 */
export function agentsGetAll(ctx: HandlerCtx, opts?: AgentQuery): AgentInfo[] {
  return ctx.deps.agentManager.getAllAgents(opts);
}

export function agentsGet(ctx: HandlerCtx, agentId: string): AgentInfo | null {
  assertString(agentId, "agentId");
  return ctx.deps.agentManager.getAgentById(agentId);
}

export function agentsGetActive(ctx: HandlerCtx): AgentInfo[] {
  return ctx.deps.agentManager.getActiveAgents();
}

export function agentsGetRecent(
  ctx: HandlerCtx,
  opts?: { limit?: number },
): AgentInfo[] {
  return ctx.deps.agentManager.getAllAgents({ limit: opts?.limit ?? 50 });
}

export function agentsGetUnseen(): {
  responded: string[];
  requires_input: string[];
} {
  return getUnseenSnapshot();
}

export function agentsBuildResumeCommand(
  ctx: HandlerCtx,
  agentId: string,
): string | null {
  assertString(agentId, "agentId");
  const agent = ctx.deps.agentManager.getAgentById(agentId);
  if (!agent || !agent.agentCommand) return null;
  return getConnector(agent.agentKind).getResumeCommand(
    agent.agentCommand,
    agent.agentSessionId,
  );
}

/**
 * Records which project/workspace a pane belongs to, so the sidebar's
 * per-pane agent metadata (and a later agent record for that pane) has a
 * project to point at. A write — this is why it is `mutating` on the ADR-178
 * bridge (ticket 10), audited by paneId the same way `pty.create` is.
 */
export function agentsSetPaneContext(
  ctx: HandlerCtx,
  paneId: string,
  context: PaneContext,
): void {
  assertString(paneId, "paneId");
  assertString(context.projectId, "projectId");
  assertString(context.projectName, "projectName");
  assertString(context.workspacePath, "workspacePath");
  ctx.deps.paneContextMap.set(paneId, context);
}

/**
 * Returns the count of agents pruned during the most recent AgentManager
 * boot, exactly once per upgrade. After the renderer consumes it, the
 * `agentPruneNoticeShown` flag is set so subsequent boots return 0.
 */
export function agentsConsumePruneNotice(ctx: HandlerCtx): number {
  const { agentManager, preferencesManager } = ctx.deps;
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
  ctx: HandlerCtx,
  agentId: string,
  updates: RendererAgentUpdate,
): AgentInfo | null {
  assertString(agentId, "agentId");
  assertRendererAgentUpdate(updates);
  const updated = ctx.deps.agentManager.updateAgent(agentId, updates);
  if (updated) {
    sendAgentUpdate(updated, ctx.deps.preferencesManager);
  }
  return updated;
}

export function agentsDelete(ctx: HandlerCtx, agentId: string): boolean {
  assertString(agentId, "agentId");
  const { unseenRespondedAgents, unseenInputAgents, preferencesManager } = ctx.deps;
  unseenRespondedAgents.delete(agentId);
  unseenInputAgents.delete(agentId);
  const result = ctx.deps.agentManager.deleteAgent(agentId);
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
export function agentsMarkSeen(ctx: HandlerCtx, agentId: string): void {
  assertString(agentId, "agentId");
  const { unseenRespondedAgents, unseenInputAgents, preferencesManager } = ctx.deps;
  unseenRespondedAgents.delete(agentId);
  unseenInputAgents.delete(agentId);
  markAgentNotificationsRead(agentId);
  const agent = ctx.deps.agentManager.getAgentById(agentId);
  if (agent) {
    sendAgentUpdate(agent, preferencesManager);
  } else {
    // Agent is gone (deleted before markSeen reached us) — at least refresh
    // the dock badge since the Sets just shrank.
    updateDockBadge(preferencesManager);
  }
}

export function agentsMarkResumed(
  ctx: HandlerCtx,
  agentId: string,
): AgentInfo | null {
  assertString(agentId, "agentId");
  return ctx.deps.agentManager.updateAgent(agentId, {
    resumedAt: new Date().toISOString(),
  });
}

/** What ending a pane's agent needs: the record, the stats, the dock badge. */
type AbandonDeps = Pick<
  HandlerCtx["deps"],
  "agentManager" | "statsStore" | "preferencesManager"
>;

/**
 * Marks the active agent on `paneId` abandoned — a session end triggered by
 * a pane close rather than by the agent itself. An agent without a name is
 * named after the pane's last title, so it stays recognisable in the list.
 */
function abandonAgentForPane(
  deps: AbandonDeps,
  { paneId, title }: EndedPane,
): void {
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

/** The {@link AgentService} `app-lifecycle.ts` hands `LayoutStore`. */
export function createAgentService(deps: AbandonDeps): AgentService {
  return {
    abandonForPanes(panes) {
      for (const pane of panes) {
        try {
          abandonAgentForPane(deps, pane);
        } catch (err) {
          console.error(`[agents] failed to abandon ${pane.paneId}:`, err);
        }
      }
    },
  };
}

/**
 * Sweeps every `active` agent whose pane the daemon no longer has a live
 * session for, and marks it `abandoned` — the desktop's boot-time cleanup
 * for sessions that died while nothing was watching. A `responded` agent is
 * left alone even if its pane is gone: it already has an outcome.
 */
export async function agentsReconcileStale(ctx: HandlerCtx): Promise<void> {
  const { agentManager, backend, preferencesManager } = ctx.deps;
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

export const agents = {
  getAll: method(agentsGetAll),
  get: method(agentsGet),
  getActive: method(agentsGetActive),
  getRecent: method(agentsGetRecent),
  getUnseen: method(agentsGetUnseen),
  consumePruneNotice: method(agentsConsumePruneNotice),
  buildResumeCommand: method(agentsBuildResumeCommand),
  // Called after every `pty.create` that has a `cwd` — without it, a pane
  // opened from a browser never gets the project context the sidebar reads.
  setPaneContext: method(agentsSetPaneContext, { mutating: true }),
  // Every write another viewer's sidebar, palette or dock badge reads:
  // `update` renames/pins, `delete` ends a session, `markSeen` and
  // `markResumed` move the unseen flags every window shares. A pane's agent
  // is abandoned by `LayoutStore` when the pane ends, not over the bridge.
  update: method(agentsUpdate, { mutating: true }),
  delete: method(agentsDelete, { mutating: true }),
  markSeen: method(agentsMarkSeen, { mutating: true }),
  markResumed: method(agentsMarkResumed, { mutating: true }),
  // Ends sessions, but `App.tsx` calls it on every mount of every window and
  // tab: a line per page load is noise that buries the lines that matter,
  // and what it ends was already dead.
  reconcileStale: method(agentsReconcileStale),
};
