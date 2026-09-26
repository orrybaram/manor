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
  /** Epoch ms the next reconnect attempt is due, while `reconnecting`. */
  retryAt?: number;
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
  busy: boolean;
  /** Registers a new remote host and starts connecting it in the background. */
  addHost: (target: string) => Promise<{ hostId: string; spec: HostSpec }>;
  retryConnect: (hostId: string) => Promise<void>;
}

export const useHostStore = create<HostState>((set) => {
  window.electronAPI?.hosts
    ?.list()
    .then((hosts) => set({ hosts }))
    .catch(() => {});

  window.electronAPI?.hosts?.onStatusChanged((hosts) => set({ hosts }));

  return {
    hosts: [],
    busy: false,

    addHost: async (target: string) => {
      set({ busy: true });
      try {
        // Main pushes `hosts:statusChanged` for the new host itself; no
        // reload needed here.
        return await window.electronAPI.hosts.add(target);
      } finally {
        set({ busy: false });
      }
    },

    retryConnect: async (hostId: string) => {
      await window.electronAPI.hosts.retryConnect(hostId);
    },
  };
});

export function selectHost(
  hostId: string | null | undefined,
): (state: HostState) => HostStatusInfo | undefined {
  return (state) => state.hosts.find((h) => h.hostId === hostId);
}
