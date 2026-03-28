import { create } from "zustand";
import { TaskInfo } from "../electron.d";
import { useToastStore } from "./toast-store";
import { useAppStore } from "./app-store";
import { navigateToTask } from "../utils/task-navigation";
import { hasPaneId } from "./pane-tree";

interface TaskState {
  tasks: TaskInfo[];
  loading: boolean;
  loaded: boolean;
  seenTaskIds: Set<string>;
  loadTasks: (opts?: {
    projectId?: string;
    status?: string;
    limit?: number;
    offset?: number;
  }) => Promise<void>;
  loadMoreTasks: (offset: number) => Promise<void>;
  removeTask: (taskId: string) => Promise<void>;
  receiveTaskUpdate: (task: TaskInfo) => void;
  markTaskSeen: (taskId: string) => void;
}

export const useTaskStore = create<TaskState>((set, get) => {
  // Subscribe to live task updates on store creation
  window.electronAPI?.tasks.onUpdate((task) => {
    get().receiveTaskUpdate(task);
  });

  // Navigate to task when a desktop notification is clicked
  window.electronAPI?.notifications.onNavigateToTask(async (taskId) => {
    const tasks = get().tasks;
    let task = tasks.find((t) => t.id === taskId) ?? null;
    if (!task) {
      task = await window.electronAPI.tasks.get(taskId);
    }
    if (task) {
      navigateToTask(task);
    }
  });

  // Eagerly load all tasks on store creation
  window.electronAPI?.tasks
    .getAll()
    .then((tasks) => {
      tasks.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      set({ tasks, loading: false, loaded: true });
    })
    .catch(() => {});

  return {
    tasks: [],
    loading: true,
    loaded: false,
    seenTaskIds: new Set<string>(),

    loadTasks: async (opts) => {
      set({ loading: true });
      try {
        const tasks = await window.electronAPI.tasks.getAll(opts);
        tasks.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        set({ tasks, loading: false, loaded: true });
      } catch {
        set({ loading: false });
      }
    },

    loadMoreTasks: async (offset: number) => {
      set({ loading: true });
      try {
        const newTasks = await window.electronAPI.tasks.getAll({ offset });
        set((s) => {
          const merged = [...s.tasks, ...newTasks];
          // Deduplicate by id, keeping the first occurrence (existing tasks take priority)
          const seen = new Set<string>();
          const deduped = merged.filter((t) => {
            if (seen.has(t.id)) return false;
            seen.add(t.id);
            return true;
          });
          deduped.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
          return { tasks: deduped, loading: false };
        });
      } catch {
        set({ loading: false });
      }
    },

    removeTask: async (taskId: string) => {
      const success = await window.electronAPI.tasks.delete(taskId);
      if (success) {
        set((s) => ({
          tasks: s.tasks.filter((t) => t.id !== taskId),
        }));
      }
    },

    markTaskSeen: (taskId: string) => {
      const s = get();
      if (!s.seenTaskIds.has(taskId)) {
        const next = new Set(s.seenTaskIds);
        next.add(taskId);
        set({ seenTaskIds: next });
      }
    },

    receiveTaskUpdate: (task: TaskInfo) => {
      const s = get();
      const idx = s.tasks.findIndex((t) => t.id === task.id);
      const prevStatus = idx >= 0 ? s.tasks[idx].lastAgentStatus : null;
      const nextStatus = task.lastAgentStatus;

      if (prevStatus !== nextStatus) {
        // Clear seen flag when status changes so a new response pulses again
        if (s.seenTaskIds.has(task.id)) {
          const next = new Set(s.seenTaskIds);
          next.delete(task.id);
          set({ seenTaskIds: next });
        }

        // Don't show toasts if the task's pane is visible in the active session
        const appState = useAppStore.getState();
        let isAlreadyVisible = false;
        if (task.paneId != null && appState.activeWorkspacePath) {
          const ws = appState.workspaceSessions[appState.activeWorkspacePath];
          if (ws) {
            const activeSession = ws.sessions.find(
              (s) => s.id === ws.selectedSessionId,
            );
            if (
              activeSession &&
              hasPaneId(activeSession.rootNode, task.paneId)
            ) {
              isAlreadyVisible = true;
            }
          }
        }

        if (
          isAlreadyVisible &&
          (nextStatus === "responded" || nextStatus === "requires_input")
        ) {
          window.electronAPI?.tasks.markSeen(task.id);
          get().markTaskSeen(task.id);
        }

        if (nextStatus === "requires_input") {
          if (!isAlreadyVisible) {
            const toastId = `task-input-${task.id}`;
            useToastStore.getState().addToast({
              id: toastId,
              message: "Task needs input",
              detail: task.name || "Agent",
              status: "loading",
              persistent: true,
              action: {
                label: "Go to task",
                onClick: () => {
                  navigateToTask(task);
                  useToastStore.getState().removeToast(toastId);
                },
              },
            });
          }
        }

        if (nextStatus === "responded") {
          if (!isAlreadyVisible) {
            const toastId = `task-responded-${task.id}`;
            useToastStore.getState().addToast({
              id: toastId,
              message: "Task responded",
              detail: task.name || "Agent",
              status: "success",
              duration: 10_000,
              action: {
                label: "Go to task",
                onClick: () => {
                  navigateToTask(task);
                  useToastStore.getState().removeToast(toastId);
                },
              },
            });
          }
        }

        if (nextStatus === "complete") {
          if (!isAlreadyVisible) {
            const toastId = `task-complete-${task.id}`;
            useToastStore.getState().addToast({
              id: toastId,
              message: "Task completed",
              detail: task.name || "Agent",
              status: "success",
            });
          }
        }
      }

      set((s) => {
        const idx = s.tasks.findIndex((t) => t.id === task.id);
        let tasks: TaskInfo[];
        if (idx >= 0) {
          // Replace existing task
          tasks = [...s.tasks];
          tasks[idx] = task;
        } else {
          // Prepend new task
          tasks = [task, ...s.tasks];
        }
        // Re-sort by createdAt descending
        tasks.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        return { tasks };
      });
    },
  };
});
