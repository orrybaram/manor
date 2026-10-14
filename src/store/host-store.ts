import { create } from "zustand";
import type { HostServerView } from "../electron.d";
import { liveValue } from "../bridge/resync";

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
  /**
   * The host server's relay room, from its last status (ADR-228 D2). Absent
   * until one has been read; null when the server has no room.
   */
  roomId?: string | null;
  /**
   * Whether the host server takes this window's own viewer stream (ADR-228
   * D3, D4). Absent until a status has been read; false for an older server.
   */
  viewerBridge?: boolean;
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
  /**
   * Each remote host's server as the Remote Control page shows it, for the
   * hosts something has asked about (`refreshServer`). Kept current by the
   * two server events.
   */
  servers: Record<string, HostServerView>;
  /** Read one host's server status and paired phones in a single call. */
  refreshServer: (hostId: string) => Promise<void>;
  /**
   * "Phones paired with this Mac can reach <host>" (ADR-228 D9). Off revokes
   * the pairings this desktop minted there.
   */
  setLinkPhones: (hostId: string, on: boolean) => Promise<void>;
  /** Registers a new remote host and starts connecting it in the background. */
  addHost: (target: string) => Promise<{ hostId: string; spec: HostSpec }>;
  retryConnect: (hostId: string) => Promise<void>;
}

export const useHostStore = create<HostState>((set) => {
  if (window.electronAPI?.hosts) {
    liveValue(
      () => window.electronAPI.hosts.list(),
      (cb) => window.electronAPI.hosts.onStatusChanged(cb),
      (hosts) => set({ hosts }),
    );
  }

  // Only the newest response for a host lands: a reload started later always
  // wins, however the replies are ordered. A host is reloaded on events only
  // once something has asked about it.
  const requests: Record<string, number> = {};
  const refreshServer = async (hostId: string): Promise<void> => {
    const request = (requests[hostId] = (requests[hostId] ?? 0) + 1);
    let view: HostServerView;
    try {
      view = await window.electronAPI.hosts.serverStatus(hostId);
    } catch {
      view = {
        state: "disconnected",
        status: null,
        devices: [],
        linkPhones: true,
        linkedDeviceIds: [],
      };
    }
    if (requests[hostId] !== request) return;
    set((s) => ({ servers: { ...s.servers, [hostId]: view } }));
  };
  const refreshIfWatched = (hostId: string): void => {
    if (hostId in requests) void refreshServer(hostId);
  };
  window.electronAPI?.hosts?.onServerChanged((info) =>
    refreshIfWatched(info.hostId),
  );
  window.electronAPI?.hosts?.onPairingChanged(refreshIfWatched);

  return {
    hosts: [],
    busy: false,
    servers: {},
    refreshServer,

    setLinkPhones: async (hostId: string, on: boolean) => {
      // Shown at once; the `pairingChanged` that follows brings the rest.
      set((s) => {
        const view = s.servers[hostId];
        return view ? { servers: { ...s.servers, [hostId]: { ...view, linkPhones: on } } } : {};
      });
      try {
        await window.electronAPI.hosts.setLinkPhones(hostId, on);
      } finally {
        void refreshServer(hostId);
      }
    },

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
