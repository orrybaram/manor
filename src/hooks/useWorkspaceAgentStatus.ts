import { useMemo } from "react";
import { useAppStore } from "../store/app-store";
import { useAgentStore } from "../store/agent-store";
import { allPaneIds } from "../store/pane-tree";
import { pickBestPaneStatus } from "./useTabAgentStatus";
import type { AgentStatus } from "../electron.d";

export function useWorkspaceAgentStatus(
  workspacePath: string,
): { status: AgentStatus | null; pulse: boolean } {
  const agents = useAgentStore((s) => s.agents);
  const unseenRespondedAgentIds = useAgentStore((s) => s.unseenRespondedAgentIds);
  const unseenInputAgentIds = useAgentStore((s) => s.unseenInputAgentIds);
  const layout = useAppStore((s) => s.workspaceLayouts[workspacePath] ?? null);
  const paneAgentStatus = useAppStore((s) => s.paneAgentStatus);

  return useMemo(() => {
    if (!layout) return { status: null, pulse: true };

    const paneIds: string[] = [];
    for (const panel of Object.values(layout.panels)) {
      for (const tab of panel.tabs) {
        paneIds.push(...allPaneIds(tab.rootNode));
      }
    }

    return pickBestPaneStatus(paneIds, {
      paneAgentStatus,
      agents,
      unseenRespondedAgentIds,
      unseenInputAgentIds,
    });
  }, [layout, paneAgentStatus, agents, unseenRespondedAgentIds, unseenInputAgentIds]);
}
