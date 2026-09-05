import { useMemo } from "react";
import { useAppStore } from "../store/app-store";
import { useTaskStore } from "../store/task-store";
import { allPaneIds } from "../store/pane-tree";
import { deriveStatus } from "./useTaskDisplay";
import { STATUS_PRIORITY } from "./useTabAgentStatus";
import type { ProjectInfo, WorkspaceInfo } from "../store/project-store";
import type { AgentStatus } from "../electron.d";

/**
 * Aggregate agent status across an arbitrary set of workspaces — the whole
 * project (see `useProjectAgentStatus`) or one folder's members.
 */
export function useWorkspacesAgentStatus(
  workspaces: WorkspaceInfo[],
): { status: AgentStatus | null; pulse: boolean } {
  const tasks = useTaskStore((s) => s.tasks);
  const unseenRespondedTaskIds = useTaskStore((s) => s.unseenRespondedTaskIds);
  const unseenInputTaskIds = useTaskStore((s) => s.unseenInputTaskIds);
  const workspaceLayouts = useAppStore((s) => s.workspaceLayouts);
  const paneAgentStatus = useAppStore((s) => s.paneAgentStatus);

  return useMemo(() => {
    let best: AgentStatus | null = null;
    let bestPriority = 0;
    let bestTaskId: string | null = null;

    for (const ws of workspaces) {
      const layout = workspaceLayouts[ws.path];
      if (!layout) continue;

      for (const panel of Object.values(layout.panels)) {
        for (const tab of panel.tabs) {
          for (const paneId of allPaneIds(tab.rootNode)) {
            const agent = paneAgentStatus[paneId] ?? null;
            const task = tasks.find((t) => t.paneId === paneId) ?? null;

            const status: AgentStatus | null = task
              ? (deriveStatus(task, agent) ?? null)
              : agent && agent.status !== "idle"
                ? agent.status
                : null;

            if (!status) continue;
            const p = STATUS_PRIORITY[status] ?? 0;
            if (p > bestPriority) {
              bestPriority = p;
              best = status;
              bestTaskId = task?.id ?? null;
            }
          }
        }
      }
    }

    const pulse = bestTaskId
      ? (best === "responded" && unseenRespondedTaskIds.has(bestTaskId)) ||
        (best === "requires_input" && unseenInputTaskIds.has(bestTaskId))
      : true;
    return { status: best, pulse };
  }, [
    workspaces,
    workspaceLayouts,
    paneAgentStatus,
    tasks,
    unseenRespondedTaskIds,
    unseenInputTaskIds,
  ]);
}

export function useProjectAgentStatus(
  project: ProjectInfo,
): { status: AgentStatus | null; pulse: boolean } {
  return useWorkspacesAgentStatus(project.workspaces);
}
