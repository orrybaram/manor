import { useAppStore, selectActiveWorkspace } from "../store/app-store";
import { allPaneIds } from "../store/pane-tree";
import type { AgentStatus } from "../electron.d";

export const STATUS_PRIORITY: Record<AgentStatus, number> = {
  waiting: 4,
  running: 3,
  error: 2,
  complete: 1,
  idle: 0,
};

export function useSessionAgentStatus(sessionId: string): AgentStatus | null {
  return useAppStore((s) => {
    const ws = selectActiveWorkspace(s);
    const session = ws?.sessions.find((t) => t.id === sessionId);
    if (!session) return null;

    const ids = allPaneIds(session.rootNode);
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
