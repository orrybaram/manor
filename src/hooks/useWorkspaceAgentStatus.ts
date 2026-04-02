import { useAppStore } from "../store/app-store";
import { allPaneIds } from "../store/pane-tree";
import { STATUS_PRIORITY } from "./useTabAgentStatus";
import type { AgentStatus } from "../electron.d";

/**
 * Returns the highest-priority non-idle agent status across all tabs
 * in a single workspace, or null if no active agents exist.
 */
export function useWorkspaceAgentStatus(
  workspacePath: string,
): AgentStatus | null {
  return useAppStore((s) => {
    let best: AgentStatus | null = null;
    let bestPriority = 0;

    const layout = s.workspaceLayouts[workspacePath];
    if (!layout) return null;

    for (const panel of Object.values(layout.panels)) {
      for (const tab of panel.tabs) {
        for (const paneId of allPaneIds(tab.rootNode)) {
          const agent = s.paneAgentStatus[paneId];
          if (!agent || agent.status === "idle") continue;
          const p = STATUS_PRIORITY[agent.status] ?? 0;
          if (p > bestPriority) {
            bestPriority = p;
            best = agent.status;
          }
        }
      }
    }

    return best;
  });
}
