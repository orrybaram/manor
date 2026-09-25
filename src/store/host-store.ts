import { create } from "zustand";

/** Mirrors `HostSpec` in `electron/backend/types.ts`. */
export type HostSpec = { kind: "ssh"; target: string };

/** Mirrors `HostStatus` in `electron/backend/registry.ts`. */
export type HostStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error";

/** Mirrors `HostFailure` in `electron/backend/types.ts`. */
export interface HostFailure {
  reason: "auth" | "host-key" | "bootstrap";
  code?: string;
  message: string;
}

/** Mirrors `HostStatusInfo` in `electron/backend/registry.ts`. */
export interface HostStatusInfo {
  hostId: string;
  spec: HostSpec | null;
  status: HostStatus;
  error?: string;
  failure?: HostFailure;
  progress?: string;
  retryInMs?: number | null;
  warnings?: string[];
}

/**
 * Live mirror of `BackendRegistry.list()` (ADR-160). One subscription, one
 * shape, pushed from main — the project settings host field and the
 * status-bar indicator read the same store so they can never disagree about
 * whether a host is reachable. Mirrors `remote-control-store.ts`.
 */
interface HostState {
  hosts: HostStatusInfo[];
  loaded: boolean;
  busy: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  /** Registers a new remote host and starts connecting it in the background. */
  addHost: (target: string) => Promise<{ hostId: string; spec: HostSpec }>;
  /** Refuses (throws) if a project still points at this host. */
  removeHost: (hostId: string) => Promise<void>;
  retryConnect: (hostId: string) => Promise<void>;
  clearError: () => void;
}

export const useHostStore = create<HostState>((set) => {
  window.electronAPI?.hosts
    ?.list()
    .then((hosts) => set({ hosts, loaded: true }))
    .catch(() => {});

  window.electronAPI?.hosts?.onStatusChanged((hosts) => set({ hosts }));

  const reload = async (): Promise<void> => {
    try {
      const hosts = await window.electronAPI.hosts.list();
      set({ hosts });
    } catch {
      // A status push will catch this app up regardless.
    }
  };

  return {
    hosts: [],
    loaded: false,
    busy: false,
    error: null,

    refresh: async () => {
      set({ busy: true });
      await reload();
      set({ busy: false, loaded: true });
    },

    addHost: async (target: string) => {
      set({ busy: true, error: null });
      try {
        const result = await window.electronAPI.hosts.add(target);
        await reload();
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        set({ error: message });
        throw err;
      } finally {
        set({ busy: false });
      }
    },

    removeHost: async (hostId: string) => {
      set({ busy: true, error: null });
      try {
        await window.electronAPI.hosts.remove(hostId);
        await reload();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        set({ error: message });
        throw err;
      } finally {
        set({ busy: false });
      }
    },

    retryConnect: async (hostId: string) => {
      await window.electronAPI.hosts.retryConnect(hostId);
    },

    clearError: () => set({ error: null }),
  };
});

export function selectHost(
  hostId: string | null | undefined,
): (state: HostState) => HostStatusInfo | undefined {
  return (state) => state.hosts.find((h) => h.hostId === hostId);
}
