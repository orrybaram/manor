import { useAppStore, selectActiveWorkspace } from "../store/app-store";
import { allPaneIds } from "../store/pane-tree";
import type { AgentStatus } from "../electron.d";

export const STATUS_PRIORITY: Record<AgentStatus, number> = {
  requires_input: 5,
  working: 4,
  thinking: 3,
  error: 2,
  responded: 1,
  complete: 1,
  idle: 0,
};

export function useTabAgentStatus(tabId: string): AgentStatus | null {
  return useAppStore((s) => {
    const ws = selectActiveWorkspace(s);
    const tab = ws?.tabs.find((t) => t.id === tabId);
    if (!tab) return null;

    const ids = allPaneIds(tab.rootNode);
    let best: AgentStatus | null = null;
    let bestPriority = 0;

    for (const id of ids) {
      const agent = s.paneAgentStatus[id];
      if (!agent) continue;
      const p = STATUS_PRIORITY[agent.status] ?? 0;
      if (p > bestPriority) {
        bestPriority = p;
        best = agent.status;
      }
    }

    return best;
  });
}
