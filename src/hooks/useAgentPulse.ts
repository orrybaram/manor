import { useCallback } from "react";
import type { AgentInfo } from "../electron.d";
import { useAgentStore } from "../store/agent-store";
import { useAppStore } from "../store/app-store";
import { isUnseenStatus, useVisiblePaneIds } from "./useTabAgentStatus";

/**
 * Returns the pulse predicate for agent dots in the agents lists — the sidebar
 * list and the Agents modal share it with the tab, workspace and project dots
 * (`isUnseenStatus`), so no two dots for one agent can disagree.
 *
 * The status tested is the one the dot shows: the pane's published status,
 * falling back to the persisted one for an agent without a published status.
 */
export function useAgentPulse(): (agent: AgentInfo) => boolean {
  const unseenRespondedAgentIds = useAgentStore((s) => s.unseenRespondedAgentIds);
  const unseenInputAgentIds = useAgentStore((s) => s.unseenInputAgentIds);
  const paneAgentStatus = useAppStore((s) => s.paneAgentStatus);
  const visiblePaneIds = useVisiblePaneIds();

  return useCallback(
    (agent: AgentInfo) => {
      const live = agent.paneId ? paneAgentStatus[agent.paneId]?.status : undefined;
      return isUnseenStatus(live ?? agent.lastAgentStatus, agent.id, agent.paneId, {
        unseenRespondedAgentIds,
        unseenInputAgentIds,
        visiblePaneIds,
      });
    },
    [paneAgentStatus, visiblePaneIds, unseenRespondedAgentIds, unseenInputAgentIds],
  );
}
