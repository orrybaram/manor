import { useCallback, useMemo } from "react";
import type { AgentInfo } from "../electron.d";
import { useAgentStore } from "../store/agent-store";
import { useAppStore, selectVisiblePaneIds } from "../store/app-store";

/**
 * Returns the pulse predicate for agent dots in the agents lists — the sidebar
 * list and the Agents modal share it so their dots cannot disagree.
 *
 * Pulse predicate (ADR-136 §"Change 3"): main owns the unseen flags; pulse iff
 * the agent's pane is off screen and its current status matches an unseen
 * axis. Visibility shares `selectVisiblePaneIds` with the read-state sweep in
 * the agent store (issue #142).
 */
export function useAgentPulse(): (agent: AgentInfo) => boolean {
  const unseenRespondedAgentIds = useAgentStore((s) => s.unseenRespondedAgentIds);
  const unseenInputAgentIds = useAgentStore((s) => s.unseenInputAgentIds);
  const workspaceLayouts = useAppStore((s) => s.workspaceLayouts);
  const activeWorkspacePath = useAppStore((s) => s.activeWorkspacePath);
  const activeWorkspaceHostId = useAppStore((s) => s.activeWorkspaceHostId);

  const visiblePaneIds = useMemo(
    () =>
      selectVisiblePaneIds({ activeWorkspacePath, activeWorkspaceHostId, workspaceLayouts }),
    [activeWorkspacePath, activeWorkspaceHostId, workspaceLayouts],
  );

  return useCallback(
    (agent: AgentInfo) => {
      const isVisible = agent.paneId != null && visiblePaneIds.has(agent.paneId);
      return (
        !isVisible &&
        ((agent.lastAgentStatus === "responded" &&
          unseenRespondedAgentIds.has(agent.id)) ||
          (agent.lastAgentStatus === "requires_input" &&
            unseenInputAgentIds.has(agent.id)))
      );
    },
    [visiblePaneIds, unseenRespondedAgentIds, unseenInputAgentIds],
  );
}
