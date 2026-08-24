import { create } from "zustand";
import type { NotificationRecord } from "../electron.d";
import { navigateToNotification } from "../utils/notification-navigation";

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
  markRead: (id: string) => Promise<void>;
  markAllRead: () => Promise<void>;
  clear: () => Promise<void>;
}

function countUnread(notifications: NotificationRecord[]): number {
  return notifications.filter((n) => !n.read).length;
}

export const useNotificationStore = create<NotificationState>((set, get) => {
  const api = window.electronAPI?.notifications;

  api?.onChanged((list) => {
    set({
      notifications: list,
      unreadCount: countUnread(list),
      loaded: true,
      loading: false,
    });
  });

  // A native banner was clicked. Same destination resolution as an in-app row
  // — one click path for both (ADR-162 §4).
  api?.onNavigate(async (id) => {
    let record = get().notifications.find((n) => n.id === id) ?? null;
    if (!record) {
      // The broadcast that carried this record may not have landed yet.
      const list = await api.getAll().catch(() => [] as NotificationRecord[]);
      set({ notifications: list, unreadCount: countUnread(list) });
      record = list.find((n) => n.id === id) ?? null;
    }
    if (record) void navigateToNotification(record);
  });

  const init = async (): Promise<void> => {
    if (!api) return;
    try {
      const list = await api.getAll();
      set({
        notifications: list,
        unreadCount: countUnread(list),
        loading: false,
        loaded: true,
      });
    } catch {
      set({ loading: false });
    }
  };
  void init();

  return {
    notifications: [],
    loading: true,
    loaded: false,
    unreadCount: 0,

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
