import { useMemo } from "react";
import { useAppStore, selectActiveWorkspace } from "../store/app-store";
import { useTaskStore } from "../store/task-store";
import { allPaneIds } from "../store/pane-tree";
import { deriveStatus } from "./useTaskDisplay";
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

export function useTabAgentStatus(tabId: string): { status: AgentStatus | null; pulse: boolean } {
  const tasks = useTaskStore((s) => s.tasks);
  const seenTaskIds = useTaskStore((s) => s.seenTaskIds);
  const tab = useAppStore((s) => {
    const ws = selectActiveWorkspace(s);
    return ws?.tabs.find((t) => t.id === tabId) ?? null;
  });
  const paneAgentStatus = useAppStore((s) => s.paneAgentStatus);

  return useMemo(() => {
    if (!tab) return { status: null, pulse: true };

    const ids = allPaneIds(tab.rootNode);
    let best: AgentStatus | null = null;
    let bestPriority = 0;
    let bestTaskId: string | null = null;

    for (const id of ids) {
      const agent = paneAgentStatus[id] ?? null;
      const task = tasks.find((t) => t.paneId === id) ?? null;

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

    const pulse = bestTaskId ? !seenTaskIds.has(bestTaskId) : true;
    return { status: best, pulse };
  }, [tab, paneAgentStatus, tasks, seenTaskIds]);
}
