import { useMemo } from "react";
import { useAppStore } from "../store/app-store";
import { useTaskStore } from "../store/task-store";
import { allPaneIds } from "../store/pane-tree";
import { deriveStatus } from "./useTaskDisplay";
import { STATUS_PRIORITY } from "./useTabAgentStatus";
import type { AgentStatus } from "../electron.d";

export function useWorkspaceAgentStatus(
  workspacePath: string,
): { status: AgentStatus | null; pulse: boolean } {
  const tasks = useTaskStore((s) => s.tasks);
  const seenTaskIds = useTaskStore((s) => s.seenTaskIds);
  const layout = useAppStore((s) => s.workspaceLayouts[workspacePath] ?? null);
  const paneAgentStatus = useAppStore((s) => s.paneAgentStatus);

  return useMemo(() => {
    if (!layout) return { status: null, pulse: true };

    let best: AgentStatus | null = null;
    let bestPriority = 0;
    let bestTaskId: string | null = null;

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

    const pulse = bestTaskId ? !seenTaskIds.has(bestTaskId) : true;
    return { status: best, pulse };
  }, [layout, paneAgentStatus, tasks, seenTaskIds]);
}
