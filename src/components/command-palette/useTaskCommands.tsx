import { useMemo } from "react";
import ListTodo from "lucide-react/dist/esm/icons/list-todo";
import Plus from "lucide-react/dist/esm/icons/plus";
import { useTaskStore } from "../../store/task-store";
import { useKeybindingsStore } from "../../store/keybindings-store";
import { useAppStore } from "../../store/app-store";
import { formatCombo } from "../../lib/keybindings";
import { deriveStatus } from "../../hooks/useTaskDisplay";
import { AgentDot } from "../ui/AgentDot/AgentDot";
import type { TaskInfo } from "../../electron.d";
import type { CommandItem } from "./types";

interface UseTaskCommandsParams {
  onResumeTask: (task: TaskInfo) => void;
  onViewAllTasks: () => void;
  onClose: () => void;
  onNewTask: () => void;
}

export function useTaskCommands({
  onResumeTask,
  onViewAllTasks,
  onClose,
  onNewTask,
}: UseTaskCommandsParams): CommandItem[] {
  const tasks = useTaskStore((s) => s.tasks);
  const bindings = useKeybindingsStore((s) => s.bindings);
  const paneAgentStatus = useAppStore((s) => s.paneAgentStatus);

  return useMemo(() => {
    const platform = navigator.platform.toLowerCase().includes("mac")
      ? ("mac" as const)
      : ("other" as const);
    const fmt = (id: string) =>
      bindings[id] ? formatCombo(bindings[id], platform) : undefined;

    const items: CommandItem[] = [
      {
        id: "new-task",
        label: "New Task",
        icon: <Plus size={14} />,
        shortcut: fmt("new-task"),
        action: () => {
          onClose();
          onNewTask();
        },
      },
    ];

    items.push(
      ...tasks.filter((t) => t.status === "active").slice(0, 5).map((task) => {
        const liveAgent = task.paneId ? paneAgentStatus[task.paneId] ?? null : null;
        const agentStatus = deriveStatus(task, liveAgent);
        return {
          id: `task-${task.id}`,
          label: task.name ?? "Agent",
          icon: (
            <AgentDot status={agentStatus} size="sidebar" />
          ),
          action: () => {
            onClose();
            onResumeTask(task);
          },
        };
      }),
    );

    items.push({
      id: "view-all-tasks",
      label: "View All Tasks...",
      icon: <ListTodo size={14} />,
      action: () => {
        onClose();
        onViewAllTasks();
      },
    });

    return items;
  }, [tasks, onResumeTask, onViewAllTasks, onClose, onNewTask, bindings, paneAgentStatus]);
}
