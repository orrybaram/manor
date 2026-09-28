import { useMemo } from "react";
import { useAppStore, selectActiveWorkspace, selectVisiblePaneIds } from "../store/app-store";
import { useAgentStore } from "../store/agent-store";
import { allPaneIds } from "../store/pane-tree";
import type { AgentInfo, AgentStatus, PaneAgentStatus } from "../electron.d";

export const STATUS_PRIORITY: Record<AgentStatus, number> = {
  requires_input: 5,
  working: 4,
  thinking: 3,
  error: 2,
  responded: 1,
  idle: 0,
};

export type PaneStatusDeps = {
  paneAgentStatus: Record<string, PaneAgentStatus | null | undefined>;
  agents: AgentInfo[];
  unseenRespondedAgentIds: Set<string>;
  unseenInputAgentIds: Set<string>;
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
  deps: Pick<PaneStatusDeps, "unseenRespondedAgentIds" | "unseenInputAgentIds" | "visiblePaneIds">,
): boolean {
  if (!agentId) return false;
  if (paneId != null && deps.visiblePaneIds?.has(paneId)) return false;
  return (
    (status === "responded" && deps.unseenRespondedAgentIds.has(agentId)) ||
    (status === "requires_input" && deps.unseenInputAgentIds.has(agentId))
  );
}

/**
 * Scan a set of pane ids and pick the single best status to represent them,
 * per STATUS_PRIORITY. On a priority tie, prefer a candidate whose agent is
 * still unseen (responded/requires_input) over one that has already been
 * seen, so a fresh unseen status isn't hidden behind an older seen one.
 */
export function pickBestPaneStatus(
  paneIds: Iterable<string>,
  deps: PaneStatusDeps,
): { status: AgentStatus | null; pulse: boolean } {
  const { paneAgentStatus, agents } = deps;

  let best: AgentStatus | null = null;
  let bestPriority = 0;
  let bestAgentId: string | null = null;
  let bestPaneId: string | null = null;

  const isUnseen = (status: AgentStatus | null, agentId: string | null, paneId: string | null) =>
    isUnseenStatus(status, agentId, paneId, deps);

  for (const id of paneIds) {
    const live = paneAgentStatus[id] ?? null;

    // The reconciler is the one decider of a pane's Agent status (ADR-184
    // §4); no per-agent fallback synthesis here.
    const status: AgentStatus | null =
      live && live.status !== "idle" ? live.status : null;

    if (!status) continue;
    const p = STATUS_PRIORITY[status] ?? 0;
    const agentId = agents.find((t) => t.paneId === id)?.id ?? null;

    if (
      p > bestPriority ||
      (p === bestPriority &&
        !isUnseen(best, bestAgentId, bestPaneId) &&
        isUnseen(status, agentId, id))
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
    ? isUnseen(best, bestAgentId, bestPaneId)
    : !(bestPaneId != null && deps.visiblePaneIds?.has(bestPaneId));
  return { status: best, pulse };
}

/**
 * The panes on screen (`selectVisiblePaneIds`), kept current with the layout.
 * The same definition the read-state sweep in the agent store uses (#142).
 */
export function useVisiblePaneIds(): ReadonlySet<string> {
  const workspaceLayouts = useAppStore((s) => s.workspaceLayouts);
  const activeWorkspacePath = useAppStore((s) => s.activeWorkspacePath);
  const activeWorkspaceHostId = useAppStore((s) => s.activeWorkspaceHostId);
  return useMemo(
    () => selectVisiblePaneIds({ activeWorkspacePath, activeWorkspaceHostId, workspaceLayouts }),
    [activeWorkspacePath, activeWorkspaceHostId, workspaceLayouts],
  );
}

/**
 * The single best agent status across `paneIds` (see `pickBestPaneStatus`),
 * kept current with the agent and pane-status stores. Memoize `paneIds`:
 * the result is recomputed whenever the array changes identity.
 */
export function useBestStatusForPanes(
  paneIds: readonly string[],
): { status: AgentStatus | null; pulse: boolean } {
  const agents = useAgentStore((s) => s.agents);
  const unseenRespondedAgentIds = useAgentStore((s) => s.unseenRespondedAgentIds);
  const unseenInputAgentIds = useAgentStore((s) => s.unseenInputAgentIds);
  const paneAgentStatus = useAppStore((s) => s.paneAgentStatus);
  const visiblePaneIds = useVisiblePaneIds();

  return useMemo(
    () =>
      pickBestPaneStatus(paneIds, {
        paneAgentStatus,
        agents,
        unseenRespondedAgentIds,
        unseenInputAgentIds,
        visiblePaneIds,
      }),
    [paneIds, paneAgentStatus, agents, unseenRespondedAgentIds, unseenInputAgentIds, visiblePaneIds],
  );
}

export function useTabAgentStatus(tabId: string): { status: AgentStatus | null; pulse: boolean } {
  const tab = useAppStore((s) => {
    const ws = selectActiveWorkspace(s);
    return ws?.tabs.find((t) => t.id === tabId) ?? null;
  });
  // No tab, no panes: `pickBestPaneStatus` then gives { null, pulse: true }.
  const paneIds = useMemo(() => (tab ? allPaneIds(tab.rootNode) : []), [tab]);
  return useBestStatusForPanes(paneIds);
}
