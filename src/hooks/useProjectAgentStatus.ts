import { useAppStore } from "../store/app-store";
import { allPaneIds } from "../store/pane-tree";
import { STATUS_PRIORITY } from "../components/useSessionAgentStatus";
import type { ProjectInfo } from "../store/project-store";
import type { AgentStatus } from "../electron.d";

/**
 * Returns the highest-priority non-idle agent status across all workspaces
 * in a project, or null if no active agents exist.
 */
export function useProjectAgentStatus(project: ProjectInfo): AgentStatus | null {
  return useAppStore((s) => {
    let best: AgentStatus | null = null;
    let bestPriority = 0;

    for (const ws of project.workspaces) {
      const workspaceSessions = s.workspaceSessions[ws.path];
      if (!workspaceSessions) continue;

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
    }

    return best;
  });
}
