/**
 * The `agents` reads and the stale-agent sweep, shared by the desktop's table
 * (`./agents.ts`) and the host server's (`../../host-server/handlers.ts`).
 *
 * Electron-free on purpose (ADR-226 S1): every handler here reads only the
 * {@link AgentReadDeps} slice, which both `HostDeps` and `HostServerDeps`
 * satisfy, so the host server lists these directly instead of copying them.
 * The desktop-only writes (dock badge, notification log) stay in `./agents.ts`.
 */

import { agentHostId, type AgentInfo, type PaneHostLookup } from "../../agent-persistence";
import type { AgentStatusDriver } from "../../agent-status/driver";
import type { PaneStatusUpdate } from "../../agent-status/effects";
import type { UnseenAgents } from "../../agent-status/unseen-agents";
import type { HostStatus } from "../../backend/host-connection";
import { LOCAL_HOST_ID } from "../../backend/types";
import { assertString } from "../../ipc-validate";
import type { HandlerCtx } from "../method";

/** What `agents:getAll` narrows its page by. */
export interface AgentQuery {
  projectId?: string;
  status?: string;
  limit?: number;
  offset?: number;
}

/** A live daemon session, as far as the sweep cares. */
interface LiveSession {
  sessionId: string;
}

/** Everything the shared agent handlers read. */
export interface AgentReadDeps {
  agentManager: {
    getAllAgents(opts?: AgentQuery): AgentInfo[];
    getAgentById(id: string): AgentInfo | null;
    getActiveAgents(): AgentInfo[];
  };
  agentStatus: Pick<
    AgentStatusDriver,
    "getAllPaneStatuses" | "isPaneLossExpected" | "signal"
  >;
  unseen: Pick<UnseenAgents, "responded" | "requiresInput">;
  backend: { pty: { listSessions(): Promise<LiveSession[]> } };
  /**
   * The host each pane's terminal runs on, and whether that host is
   * connected: the desktop's view of its remote hosts. Absent on a host
   * server, which is one host, local to itself — every agent's host is
   * connected whenever its daemon answers.
   */
  getPaneHostId?: PaneHostLookup;
  hostStatus?: (hostId: string) => HostStatus | undefined;
}

type Ctx = HandlerCtx<AgentReadDeps>;

/**
 * The `agents` namespace of the handler table. "Check on my agents from
 * anywhere" is the sentence ADR-178 started from, so none of it is
 * local-only — a browser that could watch an agent but not mark it seen was
 * exactly the read-and-type state this ADR exists to end.
 */
export function agentsGetAll(ctx: Ctx, opts?: AgentQuery): AgentInfo[] {
  return ctx.deps.agentManager.getAllAgents(opts);
}

export function agentsGet(ctx: Ctx, agentId: string): AgentInfo | null {
  assertString(agentId, "agentId");
  return ctx.deps.agentManager.getAgentById(agentId);
}

export function agentsGetActive(ctx: Ctx): AgentInfo[] {
  return ctx.deps.agentManager.getActiveAgents();
}

export function agentsGetRecent(
  ctx: Ctx,
  opts?: { limit?: number },
): AgentInfo[] {
  return ctx.deps.agentManager.getAllAgents({ limit: opts?.limit ?? 50 });
}

/** The full unseen state, to prime a renderer's cache on boot. */
export function agentsGetUnseen(ctx: Ctx): {
  responded: string[];
  requires_input: string[];
} {
  return {
    responded: [...ctx.deps.unseen.responded],
    requires_input: [...ctx.deps.unseen.requiresInput],
  };
}

/**
 * Every pane's currently published Agent status (ADR-184 ticket 5). Called
 * once on renderer startup — including a detached/popout window, a reload, or
 * a browser, which always starts after some were already sent — so it paints
 * current dots instead of waiting on the next signal.
 */
export function agentsGetPaneStatuses(ctx: Ctx): PaneStatusUpdate[] {
  return ctx.deps.agentStatus.getAllPaneStatuses();
}

/** Whether the host an agent's terminal runs on is connected (local always is). */
function isAgentHostConnected(
  deps: AgentReadDeps,
  agent: Pick<AgentInfo, "paneId" | "hostId">,
): boolean {
  const hostId = agentHostId(agent, deps.getPaneHostId ?? (() => undefined));
  if (hostId === LOCAL_HOST_ID || !deps.hostStatus) return true;
  return deps.hostStatus(hostId) === "connected";
}

/**
 * Marks `abandoned` every `active` agent whose pane is not among `live`. A
 * `responded` agent is left alone even if its pane is gone: it already has
 * an outcome.
 */
export function reconcileStaleAgents(
  deps: AgentReadDeps,
  live: readonly LiveSession[],
): void {
  const { agentManager, agentStatus } = deps;
  const livePaneIds = new Set(live.map((s) => s.sessionId));

  for (const agent of agentManager.getAllAgents()) {
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
}

/**
 * Sweeps every `active` agent whose pane the daemon no longer has a live
 * session for — the boot-time cleanup for sessions that died while nothing
 * was watching. The desktop's renderer calls it on mount; the host server
 * runs the sweep once it first catches up.
 */
export async function agentsReconcileStale(ctx: Ctx): Promise<void> {
  let live: LiveSession[];
  try {
    live = await ctx.deps.backend.pty.listSessions();
  } catch {
    // Daemon unreachable — skip reconciliation
    return;
  }
  reconcileStaleAgents(ctx.deps, live);
}
