import { useAppStore } from "../store/app-store";
import { allPaneIds } from "../store/pane-tree";
import { STATUS_PRIORITY } from "../components/useSessionAgentStatus";
import type { AgentStatus } from "../electron.d";

/**
 * Returns the highest-priority non-idle agent status across all sessions
 * in a single workspace, or null if no active agents exist.
 */
export function useWorkspaceAgentStatus(workspacePath: string): AgentStatus | null {
  return useAppStore((s) => {
    let best: AgentStatus | null = null;
    let bestPriority = 0;

    const workspaceSessions = s.workspaceSessions[workspacePath];
    if (!workspaceSessions) return null;

    for (const session of workspaceSessions.sessions) {
      for (const paneId of allPaneIds(session.rootNode)) {
        const agent = s.paneAgentStatus[paneId];
        if (!agent || agent.status === "idle") continue;
        const p = STATUS_PRIORITY[agent.status] ?? 0;
        if (p > bestPriority) {
          bestPriority = p;
          best = agent.status;
        }
      }
    }

    return best;
  });
}
