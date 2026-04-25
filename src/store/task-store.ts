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
  /**
   * Cache of main's unseen-responded Set (ADR-136 §"Change 3"). Populated by
   * the initial `tasks:getUnseen` snapshot and reconciled on every
   * `task-updated` broadcast. Renderer never resets entries on its own —
   * status-change resets are owned by main and arrive via the broadcast.
   */
  unseenRespondedTaskIds: Set<string>;
  /** Cache of main's unseen-requires-input Set. See `unseenRespondedTaskIds`. */
  unseenInputTaskIds: Set<string>;
  loadTasks: (opts?: {
    projectId?: string;
    status?: string;
    limit?: number;
    offset?: number;
  }) => Promise<void>;
  loadMoreTasks: (offset: number) => Promise<void>;
  removeTask: (taskId: string) => Promise<void>;
  receiveTaskUpdate: (
    task: TaskInfo,
    unseen?: { responded: boolean; requires_input: boolean },
  ) => void;
  markTaskSeen: (taskId: string) => void;
}

export const useTaskStore = create<TaskState>((set, get) => {
  // Subscribe to live task updates on store creation. The second argument
  // carries main's unseen flags for the broadcast task — see ADR-136
  // §"Change 3". Older preloads omit it; we pass through `undefined` and
  // let `receiveTaskUpdate` skip cache reconciliation in that case.
  window.electronAPI?.tasks.onUpdate((task, unseen) => {
    get().receiveTaskUpdate(task, unseen);
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
  // the first page of all tasks (used by the history modal) + main's
  // unseen-flag snapshot (ADR-136 §"Change 3"). The three are merged so
  // the store stays a single source of truth.
  const init = async (): Promise<void> => {
    if (!window.electronAPI?.tasks) return;
    try {
      const [active, recentPage, unseen] = await Promise.all([
        window.electronAPI.tasks.getActive(),
        window.electronAPI.tasks.getAll({ limit: TASK_PAGE_SIZE, offset: 0 }),
        // Older preloads may not expose `getUnseen` — fall back to empty.
        window.electronAPI.tasks.getUnseen
          ? window.electronAPI.tasks
              .getUnseen()
              .catch(() => ({ responded: [] as string[], requires_input: [] as string[] }))
          : Promise.resolve({ responded: [] as string[], requires_input: [] as string[] }),
      ]);
      const dedupe = new Set<string>();
      const merged: TaskInfo[] = [];
      for (const t of [...active, ...recentPage]) {
        if (dedupe.has(t.id)) continue;
        dedupe.add(t.id);
        merged.push(t);
      }
      merged.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      set({
        tasks: merged,
        loading: false,
        loaded: true,
        hasMore: recentPage.length === TASK_PAGE_SIZE,
        unseenRespondedTaskIds: new Set(unseen.responded),
        unseenInputTaskIds: new Set(unseen.requires_input),
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
    unseenRespondedTaskIds: new Set<string>(),
    unseenInputTaskIds: new Set<string>(),

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
      // Optimistically clear from the local cache. Main re-broadcasts on
      // `tasks:markSeen`, which will reconcile this same state shortly —
      // but clearing optimistically keeps the pulse from lingering visibly
      // for the duration of the IPC round-trip.
      const s = get();
      const hadResponded = s.unseenRespondedTaskIds.has(taskId);
      const hadInput = s.unseenInputTaskIds.has(taskId);
      if (hadResponded || hadInput) {
        const nextResponded = hadResponded
          ? new Set(s.unseenRespondedTaskIds)
          : s.unseenRespondedTaskIds;
        const nextInput = hadInput
          ? new Set(s.unseenInputTaskIds)
          : s.unseenInputTaskIds;
        if (hadResponded) nextResponded.delete(taskId);
        if (hadInput) nextInput.delete(taskId);
        set({
          unseenRespondedTaskIds: nextResponded,
          unseenInputTaskIds: nextInput,
        });
      }
      window.electronAPI?.tasks.markSeen(taskId);
    },

    receiveTaskUpdate: (
      task: TaskInfo,
      unseen?: { responded: boolean; requires_input: boolean },
    ) => {
      const s = get();
      const idx = s.tasks.findIndex((t) => t.id === task.id);
      const prevStatus = idx >= 0 ? s.tasks[idx].lastAgentStatus : null;
      const nextStatus = task.lastAgentStatus;

      // Reconcile the unseen-flag cache to match main's snapshot for this
      // task. Older preloads may not include the `unseen` argument; in that
      // case we leave the cache alone.
      if (unseen) {
        const hadResponded = s.unseenRespondedTaskIds.has(task.id);
        const hadInput = s.unseenInputTaskIds.has(task.id);
        const wantsResponded = unseen.responded;
        const wantsInput = unseen.requires_input;
        if (hadResponded !== wantsResponded || hadInput !== wantsInput) {
          const nextResponded = new Set(s.unseenRespondedTaskIds);
          const nextInput = new Set(s.unseenInputTaskIds);
          if (wantsResponded) nextResponded.add(task.id);
          else nextResponded.delete(task.id);
          if (wantsInput) nextInput.add(task.id);
          else nextInput.delete(task.id);
          set({
            unseenRespondedTaskIds: nextResponded,
            unseenInputTaskIds: nextInput,
          });
        }
      }

      if (prevStatus !== nextStatus) {
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
          // Main will re-broadcast on markSeen with cleared flags; the cache
          // converges on that. We also call markTaskSeen() to clear locally
          // for instant feedback.
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
