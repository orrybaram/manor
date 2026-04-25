import { create } from "zustand";
import { TaskInfo } from "../electron.d";
import { useToastStore } from "./toast-store";
import { useAppStore } from "./app-store";
import { navigateToTask } from "../utils/task-navigation";
import { hasPaneId } from "./pane-tree";

/** Page size used for the initial task load and for `loadMoreTasks`. */
const TASK_PAGE_SIZE = 100;

interface TaskState {
  tasks: TaskInfo[];
  loading: boolean;
  loaded: boolean;
  /** True when `tasks:getAll` last returned a full page — more may exist on disk. */
  hasMore: boolean;
  /** True while `loadMoreTasks` is in flight, to coalesce repeated scroll events. */
  loadingMore: boolean;
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

  // Paginated initial load: active tasks (full set, used by sidebar) +
  // the first page of all tasks (used by the history modal). The two are
  // merged + deduped so the store stays a single source of truth.
  const init = async (): Promise<void> => {
    if (!window.electronAPI?.tasks) return;
    try {
      const [active, recentPage] = await Promise.all([
        window.electronAPI.tasks.getActive(),
        window.electronAPI.tasks.getAll({ limit: TASK_PAGE_SIZE, offset: 0 }),
      ]);
      const seen = new Set<string>();
      const merged: TaskInfo[] = [];
      for (const t of [...active, ...recentPage]) {
        if (seen.has(t.id)) continue;
        seen.add(t.id);
        merged.push(t);
      }
      merged.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      set({
        tasks: merged,
        loading: false,
        loaded: true,
        hasMore: recentPage.length === TASK_PAGE_SIZE,
      });

      // One-time prune notice. Surfaces only when the most recent boot
      // actually deleted tasks AND the user has not been notified yet.
      try {
        const prunedCount = await window.electronAPI.tasks.consumePruneNotice();
        if (prunedCount > 0) {
          useToastStore.getState().addToast({
            id: "task-prune-notice",
            message: `Pruned ${prunedCount} old task${prunedCount === 1 ? "" : "s"}`,
            detail: "Configure retention in Preferences",
            status: "success",
            duration: 8_000,
          });
        }
      } catch {
        // Older preload — feature absent. Safe to ignore.
      }
    } catch {
      set({ loading: false });
    }
  };
  init();

  return {
    tasks: [],
    loading: true,
    loaded: false,
    hasMore: false,
    loadingMore: false,
    seenTaskIds: new Set<string>(),

    loadTasks: async (opts) => {
      set({ loading: true });
      try {
        const tasks = await window.electronAPI.tasks.getAll(opts);
        tasks.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        set({
          tasks,
          loading: false,
          loaded: true,
          // If the caller passed an explicit limit, treat a full result as
          // "may have more". For unbounded calls there is by definition no
          // next page.
          hasMore:
            opts?.limit !== undefined ? tasks.length === opts.limit : false,
        });
      } catch {
        set({ loading: false });
      }
    },

    loadMoreTasks: async (offset: number) => {
      const s = get();
      // Coalesce repeated scroll events and short-circuit when we've
      // already exhausted the underlying store.
      if (s.loadingMore || !s.hasMore) return;
      set({ loadingMore: true });
      try {
        const newTasks = await window.electronAPI.tasks.getAll({
          offset,
          limit: TASK_PAGE_SIZE,
        });
        set((state) => {
          const merged = [...state.tasks, ...newTasks];
          // Deduplicate by id, keeping the first occurrence (existing tasks take priority)
          const seen = new Set<string>();
          const deduped = merged.filter((t) => {
            if (seen.has(t.id)) return false;
            seen.add(t.id);
            return true;
          });
          deduped.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
          return {
            tasks: deduped,
            loadingMore: false,
            hasMore: newTasks.length === TASK_PAGE_SIZE,
          };
        });
      } catch {
        set({ loadingMore: false });
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

        // Don't show toasts if the task's pane is visible in the active tab
        const appState = useAppStore.getState();
        let isAlreadyVisible = false;
        if (task.paneId != null && appState.activeWorkspacePath) {
          const layout = appState.workspaceLayouts[appState.activeWorkspacePath];
          if (layout) {
            const panel = layout.panels[layout.activePanelId];
            if (panel) {
              const activeTab = panel.tabs.find(
                (s) => s.id === panel.selectedTabId,
              );
              if (
                activeTab &&
                hasPaneId(activeTab.rootNode, task.paneId)
              ) {
                isAlreadyVisible = true;
              }
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
          // Prepend new task — clear stale pane title from the previous session
          if (task.paneId) {
            useAppStore.getState().clearPaneTitle(task.paneId);
          }
          tasks = [task, ...s.tasks];
        }
        // Re-sort by createdAt descending
        tasks.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        return { tasks };
      });
    },
  };
});
