import { create } from "zustand";
import type { HostServerView } from "../electron.d";
import { liveValue } from "../bridge/resync";
import { provideHostLookups } from "../bridge/host-lookups";

/** Mirrors `HostSpec` in `electron/backend/types.ts`. */
export type HostSpec = { kind: "ssh"; target: string } | { kind: "recipe"; recipeId: string };

/** Mirrors `HostStatus` in `electron/backend/registry.ts`. */
export type HostStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error"
  /** The box was put to sleep; a write for it wakes it (ADR-229 D1). */
  | "sleeping";

/** Mirrors `ProviderCapabilities` in `electron/backend/providers/types.ts`. */
interface ProviderCapabilities {
  canStop: boolean;
  canDestroy: boolean;
  autoSleep: boolean;
}

/** Mirrors `HostFailure` in `electron/backend/types.ts`. */
export interface HostFailure {
  reason: "auth" | "host-key" | "bootstrap" | "recipe";
  code?: string;
  message: string;
}

/** Mirrors `HostStatusInfo` in `electron/backend/registry.ts`. */
export interface HostStatusInfo {
  hostId: string;
  spec: HostSpec | null;
  /**
   * How the user names a remote host: its ssh target, or a recipe host's
   * recipe name (ADR-229 D2). Absent for the local host. Read it through
   * `hostName` (`lib/hosts.ts`).
   */
  label?: string;
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
  /**
   * Whether the desktop has handed the host its records (ADR-227 D3): main
   * opens a window's viewer stream only to an adopted host. Absent on a
   * host server's own list and for the local host.
   */
  adopted?: boolean;
  /**
   * The remote host's kind of box and what Manor can do to it (ADR-229 D1),
   * so Wake, Stop and Destroy are offered only where they work. Absent for
   * the local host.
   */
  providerKind?: "ssh" | "recipe";
  capabilities?: ProviderCapabilities;
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

// Whether a host is asleep, for the bridge router's wake-on-write (ADR-229 D1).
provideHostLookups({
  hostStatus: (hostId) => useHostStore.getState().hosts.find((h) => h.hostId === hostId)?.status,
});
