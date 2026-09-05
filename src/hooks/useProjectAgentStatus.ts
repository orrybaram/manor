import { useMemo } from "react";
import { useAppStore } from "../store/app-store";
import { useAgentStore } from "../store/agent-store";
import { allPaneIds } from "../store/pane-tree";
import { pickBestPaneStatus } from "./useTabAgentStatus";
import type { ProjectInfo } from "../store/project-store";
import type { AgentStatus } from "../electron.d";

export function useProjectAgentStatus(
  project: ProjectInfo,
): { status: AgentStatus | null; pulse: boolean } {
  const agents = useAgentStore((s) => s.agents);
  const unseenRespondedAgentIds = useAgentStore((s) => s.unseenRespondedAgentIds);
  const unseenInputAgentIds = useAgentStore((s) => s.unseenInputAgentIds);
  const workspaceLayouts = useAppStore((s) => s.workspaceLayouts);
  const paneAgentStatus = useAppStore((s) => s.paneAgentStatus);

  return useMemo(() => {
    const paneIds: string[] = [];
    for (const ws of project.workspaces) {
      const layout = workspaceLayouts[ws.path];
      if (!layout) continue;

      for (const panel of Object.values(layout.panels)) {
        for (const tab of panel.tabs) {
          paneIds.push(...allPaneIds(tab.rootNode));
        }
      }
    }

    return pickBestPaneStatus(paneIds, {
      paneAgentStatus,
      agents,
      unseenRespondedAgentIds,
      unseenInputAgentIds,
    });
  }, [
    project.workspaces,
    workspaceLayouts,
    paneAgentStatus,
    agents,
    unseenRespondedAgentIds,
    unseenInputAgentIds,
  ]);
}
