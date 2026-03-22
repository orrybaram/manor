import { create } from "zustand";
import { TaskInfo } from "../electron.d";
import { useToastStore } from "./toast-store";
import { navigateToTask } from "../utils/task-navigation";

interface TaskState {
  tasks: TaskInfo[];
  loading: boolean;
  loaded: boolean;
  loadTasks: (opts?: { projectId?: string; status?: string; limit?: number; offset?: number }) => Promise<void>;
  loadMoreTasks: (offset: number) => Promise<void>;
  removeTask: (taskId: string) => Promise<void>;
  receiveTaskUpdate: (task: TaskInfo) => void;
}

export const useTaskStore = create<TaskState>((set, get) => {
  // Subscribe to live task updates on store creation
  window.electronAPI?.tasks.onUpdate((task) => {
    get().receiveTaskUpdate(task);
  });

  // Eagerly load all tasks on store creation
  window.electronAPI?.tasks.getAll().then((tasks) => {
    tasks.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    set({ tasks, loading: false, loaded: true });
  }).catch(() => {});

  return {
    tasks: [],
    loading: true,
    loaded: false,

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

    receiveTaskUpdate: (task: TaskInfo) => {
      const s = get();
      const idx = s.tasks.findIndex((t) => t.id === task.id);

      // Fire toasts only when updating an existing task (idx >= 0)
      if (idx >= 0) {
        const prevTask = s.tasks[idx];
        const prevStatus = prevTask.lastAgentStatus;
        const nextStatus = task.lastAgentStatus;

        if (prevStatus !== nextStatus) {
          if (nextStatus === "complete") {
            useToastStore.getState().addToast({
              id: `task-done-${task.id}`,
              message: `Task completed: ${task.name || "Agent"}`,
              status: "success",
            });
          } else if (nextStatus === "requires_input") {
            useToastStore.getState().addToast({
              id: `task-input-${task.id}`,
              message: `Task needs input: ${task.name || "Agent"}`,
              status: "loading",
              persistent: true,
              action: {
                label: "Go to task",
                onClick: () => navigateToTask(task),
              },
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
