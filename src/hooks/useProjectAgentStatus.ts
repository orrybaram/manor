import { useMemo } from "react";
import { useAppStore } from "../store/app-store";
import { useTaskStore } from "../store/task-store";
import { allPaneIds } from "../store/pane-tree";
import { deriveStatus } from "./useTaskDisplay";
import { STATUS_PRIORITY } from "./useTabAgentStatus";
import type { ProjectInfo } from "../store/project-store";
import type { AgentStatus } from "../electron.d";

export function useProjectAgentStatus(
  project: ProjectInfo,
): { status: AgentStatus | null; pulse: boolean } {
  const tasks = useTaskStore((s) => s.tasks);
  const seenTaskIds = useTaskStore((s) => s.seenTaskIds);
  const workspaceLayouts = useAppStore((s) => s.workspaceLayouts);
  const paneAgentStatus = useAppStore((s) => s.paneAgentStatus);

  return useMemo(() => {
    let best: AgentStatus | null = null;
    let bestPriority = 0;
    let bestTaskId: string | null = null;

    for (const ws of project.workspaces) {
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

    const pulse = bestTaskId ? !seenTaskIds.has(bestTaskId) : true;
    return { status: best, pulse };
  }, [project.workspaces, workspaceLayouts, paneAgentStatus, tasks, seenTaskIds]);
}
