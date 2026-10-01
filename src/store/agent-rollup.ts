import { useMemo, useSyncExternalStore } from "react";
import { useAppStore, selectVisiblePaneIds, type AppState } from "./app-store";
import { useAgentStore, selectPaneAgentIndex, type AgentStoreState } from "./agent-store";
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

/** What the rollup reads from the app and agent stores. */
export interface AgentRollupSources {
  app: Pick<
    AppState,
    "paneAgentStatus" | "workspaceLayouts" | "activeWorkspacePath" | "activeWorkspaceHostId"
  >;
  agents: Pick<AgentStoreState, "agents" | "unseenRespondedAgentIds" | "unseenInputAgentIds">;
}

type UnseenDeps = Pick<AgentStoreState, "unseenRespondedAgentIds" | "unseenInputAgentIds"> & {
  /**
   * Panes on screen (`selectVisiblePaneIds`). A pane on screen has been read,
   * so its status never pulses. Omitted → nothing is on screen.
   */
  visiblePaneIds?: ReadonlySet<string>;
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
  if (paneId != null && deps.visiblePaneIds?.has(paneId)) return false;
  return (
    (status === "responded" && deps.unseenRespondedAgentIds.has(agentId)) ||
    (status === "requires_input" && deps.unseenInputAgentIds.has(agentId))
  );
}

let visibleCache: { app: AgentRollupSources["app"] | null; ids: ReadonlySet<string> } = {
  app: null,
  ids: new Set(),
};

/** `selectVisiblePaneIds`, built once per layout change rather than per row. */
function visiblePaneIdsOf(app: AgentRollupSources["app"]): ReadonlySet<string> {
  const prev = visibleCache.app;
  if (
    !prev ||
    prev.workspaceLayouts !== app.workspaceLayouts ||
    prev.activeWorkspacePath !== app.activeWorkspacePath ||
    prev.activeWorkspaceHostId !== app.activeWorkspaceHostId
  ) {
    visibleCache = { app, ids: selectVisiblePaneIds(app) };
  }
  return visibleCache.ids;
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
    visiblePaneIds: visiblePaneIdsOf(sources.app),
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
    : !(bestPaneId != null && deps.visiblePaneIds?.has(bestPaneId));
  return { status: best, pulse };
}

/** Picks the panes a dot speaks for out of the current store state. */
export type PaneSetSelector = (
  sources: { app: AppState; agents: AgentStoreState },
) => Iterable<string>;

function subscribeBoth(onChange: () => void): () => void {
  const unsubApp = useAppStore.subscribe(onChange);
  const unsubAgents = useAgentStore.subscribe(onChange);
  return () => {
    unsubApp();
    unsubAgents();
  };
}

/**
 * A `getSnapshot` for `useSyncExternalStore`: the rollup of the panes
 * `selectPanes` picks, recomputed only when an input it can depend on changes,
 * and the same object back while status and pulse stay the same.
 */
function rollupSnapshot(selectPanes: PaneSetSelector): () => AgentRollup {
  let inputs: readonly unknown[] = [];
  let result: AgentRollup | null = null;
  return () => {
    const app = useAppStore.getState();
    const agents = useAgentStore.getState();
    const next = [
      app.workspaceLayouts,
      app.activeWorkspacePath,
      app.activeWorkspaceHostId,
      app.paneAgentStatus,
      agents.agents,
      agents.unseenRespondedAgentIds,
      agents.unseenInputAgentIds,
    ];
    if (result && next.every((v, i) => v === inputs[i])) return result;
    inputs = next;
    const rollup = selectAgentRollup({ app, agents }, selectPanes({ app, agents }));
    if (!result || result.status !== rollup.status || result.pulse !== rollup.pulse) {
      result = rollup;
    }
    return result;
  };
}

/**
 * The rollup (`selectAgentRollup`) for the panes `selectPanes` picks, kept
 * current with the app and agent stores. The caller re-renders only when its
 * own status or pulse changes; store changes the rollup cannot depend on
 * (titles, focus elsewhere…) skip the recompute entirely.
 * Memoize `selectPanes`: a new function each render recomputes.
 */
export function useAgentRollup(selectPanes: PaneSetSelector): AgentRollup {
  const getSnapshot = useMemo(() => rollupSnapshot(selectPanes), [selectPanes]);
  return useSyncExternalStore(subscribeBoth, getSnapshot);
}
