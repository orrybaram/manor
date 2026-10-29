import { create } from "zustand";
import type { NotificationRecord } from "../electron.d";
import { navigateToNotification } from "../utils/notification-navigation";
import { liveValue } from "../bridge/resync";
import { ipcErrorMessage } from "../lib/ipc-error";
import { LOCAL_HOST_ID } from "../lib/workspace-key";

/**
 * Renderer cache of main's notification log.
 *
 * Main owns the list. Every mutation here is an IPC call whose effect arrives
 * back through the `notifications:changed` broadcast — the renderer never
 * mutates its copy speculatively, the same ownership split the agent store
 * uses for the unseen sets.
 *
 * The list is every server's log, merged newest first (on the desktop by
 * main, across servers by the router), each record naming the host whose
 * server keeps it (`hostId`). A mark or a clear goes to that host's log:
 * `markRead` by the record's host, `markAllRead` and `clear` to each host
 * the list holds records of.
 */
interface NotificationState {
  /** Newest first, exactly as main sends it. */
  notifications: NotificationRecord[];
  loading: boolean;
  loaded: boolean;
  /** Derived from `notifications` on every set; never independent state. */
  unreadCount: number;
  /**
   * Why the last read of the log failed, until one succeeds.
   * The list keeps what it had; the popover says so instead of "Nothing
   * here yet." when it has nothing.
   */
  loadError: string | null;
  /** Read the log again. */
  retry: () => Promise<void>;
  /** `hostId`: the host keeping the record; the list's word for it when absent. */
  markRead: (id: string, hostId?: string | null) => Promise<void>;
  markAllRead: () => Promise<void>;
  clear: () => Promise<void>;
}

function countUnread(notifications: NotificationRecord[]): number {
  return notifications.filter((n) => !n.read).length;
}

/**
 * Each host the records are kept by, the home server's own (null) always
 * among them, so a mark with nothing loaded still reaches it.
 */
function hostsOf(records: NotificationRecord[]): (string | null)[] {
  const hosts = new Set<string | null>([null]);
  for (const record of records) {
    if (record.hostId && record.hostId !== LOCAL_HOST_ID) hosts.add(record.hostId);
  }
  return [...hosts];
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
  // — one click path for both.
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

    markRead: async (id: string, hostId?: string | null) => {
      const host = hostId ?? get().notifications.find((n) => n.id === id)?.hostId ?? null;
      await window.electronAPI?.notifications.markRead(id, host);
    },

    markAllRead: async () => {
      const hosts = hostsOf(get().notifications.filter((n) => !n.read));
      await Promise.all(hosts.map((hostId) => window.electronAPI?.notifications.markAllRead(hostId)));
    },

    clear: async () => {
      const hosts = hostsOf(get().notifications);
      await Promise.all(hosts.map((hostId) => window.electronAPI?.notifications.clear(hostId)));
    },
  };
});
