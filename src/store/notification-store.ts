import { create } from "zustand";
import type { NotificationRecord } from "../electron.d";
import { navigateToNotification } from "../utils/notification-navigation";
import { liveValue } from "../bridge/resync";
import { ipcErrorMessage } from "../lib/ipc-error";

/**
 * Renderer cache of main's notification log (ADR-162 §5).
 *
 * Main owns the list. Every mutation here is an IPC call whose effect arrives
 * back through the `notifications:changed` broadcast — the renderer never
 * mutates its copy speculatively, the same ownership split ADR-136 uses for
 * the unseen sets.
 */
interface NotificationState {
  /** Newest first, exactly as main sends it. */
  notifications: NotificationRecord[];
  loading: boolean;
  loaded: boolean;
  /** Derived from `notifications` on every set; never independent state. */
  unreadCount: number;
  /**
   * Why the last read of the log failed, until one succeeds (ADR-232 D7).
   * The list keeps what it had; the popover says so instead of "Nothing
   * here yet." when it has nothing.
   */
  loadError: string | null;
  /** Read the log again. */
  retry: () => Promise<void>;
  markRead: (id: string) => Promise<void>;
  markAllRead: () => Promise<void>;
  clear: () => Promise<void>;
}

function countUnread(notifications: NotificationRecord[]): number {
  return notifications.filter((n) => !n.read).length;
}

export const useNotificationStore = create<NotificationState>((set, get) => {
  const api = window.electronAPI?.notifications;

  const apply = (list: NotificationRecord[]) =>
    set({
      notifications: list,
      unreadCount: countUnread(list),
      loaded: true,
      loading: false,
      loadError: null,
    });

  const fetchAll = async (): Promise<NotificationRecord[]> => {
    try {
      return (await api?.getAll()) ?? [];
    } catch (err) {
      set({ loading: false, loadError: ipcErrorMessage(err) });
      throw err;
    }
  };

  // Counted so a retry whose answer is older than a push drops it, as
  // `liveValue`'s own fetches do.
  let pushes = 0;

  if (api) {
    liveValue(
      fetchAll,
      (cb) =>
        api.onChanged((list) => {
          pushes += 1;
          cb(list);
        }),
      apply,
    );
  }

  // A native banner was clicked. Same destination resolution as an in-app row
  // — one click path for both (ADR-162 §4).
  api?.onNavigate(async (id) => {
    let record = get().notifications.find((n) => n.id === id) ?? null;
    if (!record) {
      // The broadcast that carried this record may not have landed yet.
      // A failed read keeps the list we have rather than wiping it.
      const list = await api.getAll().catch(() => null);
      if (list) {
        set({ notifications: list, unreadCount: countUnread(list) });
        record = list.find((n) => n.id === id) ?? null;
      }
    }
    if (record) void navigateToNotification(record);
  });

  return {
    notifications: [],
    loading: true,
    loaded: false,
    unreadCount: 0,
    loadError: null,

    retry: async () => {
      if (!api) return;
      set({ loading: true });
      const before = pushes;
      try {
        const list = await fetchAll();
        if (pushes === before) apply(list);
        else set({ loading: false, loadError: null });
      } catch {
        // `fetchAll` recorded why.
      }
    },

    markRead: async (id: string) => {
      await window.electronAPI?.notifications.markRead(id);
    },

    markAllRead: async () => {
      await window.electronAPI?.notifications.markAllRead();
    },

    clear: async () => {
      await window.electronAPI?.notifications.clear();
    },
  };
});
