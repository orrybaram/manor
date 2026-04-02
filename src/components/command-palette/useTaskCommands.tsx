import { useMemo } from "react";
import ListTodo from "lucide-react/dist/esm/icons/list-todo";
import Plus from "lucide-react/dist/esm/icons/plus";
import { useTaskStore } from "../../store/task-store";
import { AgentDot } from "../ui/AgentDot/AgentDot";
import type { TaskInfo, TaskStatus, AgentStatus } from "../../electron.d";
import type { CommandItem } from "./types";

function mapTaskStatusToAgentStatus(task: TaskInfo): AgentStatus | undefined {
  if (task.status === "active" && task.lastAgentStatus) {
    return task.lastAgentStatus as AgentStatus;
  }

  const statusMap: Record<TaskStatus, AgentStatus> = {
    active: "working",
    completed: "complete",
    error: "error",
    abandoned: "idle",
  };

  return statusMap[task.status];
}

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

  return useMemo(() => {
    const items: CommandItem[] = [
      {
        id: "new-task",
        label: "New Task",
        icon: <Plus size={14} />,
        shortcut: "⌘N",
        action: () => {
          onClose();
          onNewTask();
        },
      },
    ];

    items.push(
      ...tasks.filter((t) => t.status === "active").slice(0, 5).map((task) => ({
        id: `task-${task.id}`,
        label: task.name || "Untitled Task",
        icon: (
          <AgentDot status={mapTaskStatusToAgentStatus(task)} size="sidebar" />
        ),
        action: () => {
          onClose();
          onResumeTask(task);
        },
      })),
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
  }, [tasks, onResumeTask, onViewAllTasks, onClose, onNewTask]);
}
