import { useMemo } from "react";
import { useAppStore, selectActiveWorkspace } from "../store/app-store";
import { useAgentStore } from "../store/agent-store";
import { allPaneIds } from "../store/pane-tree";
import { deriveStatus } from "./useAgentDisplay";
import type { AgentInfo, AgentState, AgentStatus } from "../electron.d";

export const STATUS_PRIORITY: Record<AgentStatus, number> = {
  requires_input: 5,
  working: 4,
  thinking: 3,
  error: 2,
  responded: 1,
  complete: 1,
  idle: 0,
};

export type PaneStatusDeps = {
  paneAgentStatus: Record<string, AgentState | null | undefined>;
  agents: AgentInfo[];
  unseenRespondedAgentIds: Set<string>;
  unseenInputAgentIds: Set<string>;
};

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
  const { paneAgentStatus, agents, unseenRespondedAgentIds, unseenInputAgentIds } = deps;

  let best: AgentStatus | null = null;
  let bestPriority = 0;
  let bestAgentId: string | null = null;

  const isUnseen = (status: AgentStatus | null, agentId: string | null): boolean => {
    if (!agentId) return false;
    return (
      (status === "responded" && unseenRespondedAgentIds.has(agentId)) ||
      (status === "requires_input" && unseenInputAgentIds.has(agentId))
    );
  };

  for (const id of paneIds) {
    const live = paneAgentStatus[id] ?? null;
    const agent = agents.find((t) => t.paneId === id) ?? null;

    const status: AgentStatus | null = agent
      ? (deriveStatus(agent, live) ?? null)
      : live && live.status !== "idle"
        ? live.status
        : null;

    if (!status) continue;
    const p = STATUS_PRIORITY[status] ?? 0;
    const agentId = agent?.id ?? null;

    if (
      p > bestPriority ||
      (p === bestPriority && !isUnseen(best, bestAgentId) && isUnseen(status, agentId))
    ) {
      bestPriority = p;
      best = status;
      bestAgentId = agentId;
    }
  }

  // Pulse predicate (ADR-136 §"Change 3"): main owns unseen state. Pulse
  // iff the winning status matches an axis that's still unseen for that
  // agent.
  const pulse = bestAgentId ? isUnseen(best, bestAgentId) : true;
  return { status: best, pulse };
}

export function useTabAgentStatus(tabId: string): { status: AgentStatus | null; pulse: boolean } {
  const agents = useAgentStore((s) => s.agents);
  const unseenRespondedAgentIds = useAgentStore((s) => s.unseenRespondedAgentIds);
  const unseenInputAgentIds = useAgentStore((s) => s.unseenInputAgentIds);
  const tab = useAppStore((s) => {
    const ws = selectActiveWorkspace(s);
    return ws?.tabs.find((t) => t.id === tabId) ?? null;
  });
  const paneAgentStatus = useAppStore((s) => s.paneAgentStatus);

  return useMemo(() => {
    if (!tab) return { status: null, pulse: true };

    return pickBestPaneStatus(allPaneIds(tab.rootNode), {
      paneAgentStatus,
      agents,
      unseenRespondedAgentIds,
      unseenInputAgentIds,
    });
  }, [tab, paneAgentStatus, agents, unseenRespondedAgentIds, unseenInputAgentIds]);
}
