import { selectVisiblePaneIds, type AppState } from "./app-store";
import { selectPaneAgentIndex, type AgentStoreState } from "./agent-store";
import type { AgentStatus } from "../electron.d";

export const STATUS_PRIORITY: Record<AgentStatus, number> = {
  requires_input: 5,
  working: 4,
  thinking: 3,
  error: 2,
  responded: 1,
  idle: 0,
};

/** The Agent status one dot shows for a set of panes. Display only. */
export interface AgentRollup {
  status: AgentStatus | null;
  pulse: boolean;
}

/**
 * The only store fields a rollup — and the pane set it rolls up — may read.
 * `AgentRollupSources` is typed from these lists, and `rollupInputs` watches
 * exactly them, so a pane-set selector cannot read a field no one watches.
 */
const APP_FIELDS = [
  "paneAgentStatus",
  "workspaceLayouts",
  "activeWorkspacePath",
  "activeWorkspaceHostId",
] as const satisfies readonly (keyof AppState)[];
const AGENT_FIELDS = [
  "agents",
  "unseenRespondedAgentIds",
  "unseenInputAgentIds",
] as const satisfies readonly (keyof AgentStoreState)[];

/** What the rollup reads from the app and agent stores. */
export interface AgentRollupSources {
  app: Pick<AppState, (typeof APP_FIELDS)[number]>;
  agents: Pick<AgentStoreState, (typeof AGENT_FIELDS)[number]>;
}

/** Every input a rollup depends on, in a fixed order, for identity comparison. */
export function rollupInputs(sources: AgentRollupSources): unknown[] {
  return [
    ...APP_FIELDS.map((f) => sources.app[f]),
    ...AGENT_FIELDS.map((f) => sources.agents[f]),
  ];
}

type UnseenDeps = Pick<AgentStoreState, "unseenRespondedAgentIds" | "unseenInputAgentIds"> & {
  /**
   * Panes on screen (`selectVisiblePaneIds`). A pane on screen has been read,
   * so its status never pulses.
   */
  visiblePaneIds: ReadonlySet<string>;
};

/**
 * The one pulse predicate (ADR-136 §"Change 3"), shared by every agent dot —
 * tab, workspace, project and the agents lists — so they cannot disagree.
 * Pulse iff the pane is off screen and `status` matches an axis main still
 * holds unseen for the agent.
 */
export function isUnseenStatus(
  status: AgentStatus | string | null | undefined,
  agentId: string | null,
  paneId: string | null,
  deps: UnseenDeps,
): boolean {
  if (!agentId) return false;
  if (paneId != null && deps.visiblePaneIds.has(paneId)) return false;
  return (
    (status === "responded" && deps.unseenRespondedAgentIds.has(agentId)) ||
    (status === "requires_input" && deps.unseenInputAgentIds.has(agentId))
  );
}

/**
 * The single best Agent status across `paneIds`, per STATUS_PRIORITY. On a
 * priority tie, prefer a pane whose agent is still unseen over one already
 * seen, so a fresh unseen status isn't hidden behind an older seen one.
 *
 * Display only: the Status reconciler is the one decider of a pane's Agent
 * status (ADR-184 §4); this only picks among what it published.
 */
export function selectAgentRollup(
  sources: AgentRollupSources,
  paneIds: Iterable<string>,
): AgentRollup {
  const { paneAgentStatus } = sources.app;
  const agentIdByPaneId = selectPaneAgentIndex(sources.agents);
  const deps: UnseenDeps = {
    unseenRespondedAgentIds: sources.agents.unseenRespondedAgentIds,
    unseenInputAgentIds: sources.agents.unseenInputAgentIds,
    visiblePaneIds: selectVisiblePaneIds(sources.app),
  };

  let best: AgentStatus | null = null;
  let bestPriority = 0;
  let bestAgentId: string | null = null;
  let bestPaneId: string | null = null;

  for (const id of paneIds) {
    const live = paneAgentStatus[id] ?? null;
    const status: AgentStatus | null = live && live.status !== "idle" ? live.status : null;
    if (!status) continue;
    const p = STATUS_PRIORITY[status] ?? 0;
    const agentId = agentIdByPaneId.get(id) ?? null;

    if (
      p > bestPriority ||
      (p === bestPriority &&
        !isUnseenStatus(best, bestAgentId, bestPaneId, deps) &&
        isUnseenStatus(status, agentId, id, deps))
    ) {
      bestPriority = p;
      best = status;
      bestAgentId = agentId;
      bestPaneId = id;
    }
  }

  // No agent row for the winning pane (not loaded yet): pulse unless the pane
  // is on screen, since nothing says it has been read.
  const pulse = bestAgentId
    ? isUnseenStatus(best, bestAgentId, bestPaneId, deps)
    : !(bestPaneId != null && deps.visiblePaneIds.has(bestPaneId));
  return { status: best, pulse };
}
