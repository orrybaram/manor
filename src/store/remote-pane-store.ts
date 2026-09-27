import { create } from "zustand";
import { LOCAL_HOST_ID } from "../lib/hosts";
import { allPaneIds, type PaneNode } from "./pane-tree";

/**
 * What the renderer knows about a pane that runs — or waits to run — on a
 * remote host (ADR-160, ADR-178 §6). One entry per pane, one store for all of
 * it (ADR-183), so forgetting a pane forgets everything about it.
 */
export interface RemotePane {
  /**
   * The remote host the pane's session ACTUALLY runs on, as reported by main
   * when `pty:create` / `pty:reset` resolves; null once it runs locally.
   *
   * Deliberately not derived from the project's current `hostId`: a project
   * can be moved to another host while its panes keep running where they
   * started, and a tab must badge where its terminal really is.
   */
  hostId: string | null;
  /**
   * The pane has no session yet because its remote host was not connected
   * when it tried to create one — an app launched while the host is down,
   * or a pane opened on it meanwhile. `hostId` is the host it awaits, so it
   * shows that host's offline banner; once the host connects it is remounted
   * to create its session then (see `takePanesAwaitingHost`).
   */
  awaiting: boolean;
  /**
   * The pane's `TerminalPane` is keyed by this, so bumping it (`reattach`)
   * remounts the pane and runs the ordinary create/attach path:
   *
   * - a session that survived its remote host's drop comes back through its
   *   warm-restore snapshot — the output it printed while the host was away
   *   was never delivered, so the old screen is stale;
   * - a session the host lost (its daemon restarted) is created afresh in the
   *   pane's cwd, running whatever command was queued for the pane.
   */
  reattachEpoch: number;
  /** The pane's next mount is a reattach, not a user opening it. */
  reattachPending: boolean;
}

const NO_PANE: RemotePane = {
  hostId: null,
  awaiting: false,
  reattachEpoch: 0,
  reattachPending: false,
};

/**
 * Only remote panes have entries. A local pane — and a pane created before
 * main reported hosts — is simply absent, so local-only users never cause a
 * single update to this store (and so never re-render a subscriber).
 */
interface RemotePaneState {
  panes: Record<string, RemotePane>;
  /**
   * Record where `paneId`'s session runs; it is no longer awaiting its host.
   * Local / unknown clears the host.
   */
  setPaneHost: (paneId: string, hostId: string | undefined) => void;
  /**
   * Record that `paneId` could not create its session because remote host
   * `hostId` is not connected: it badges and banners as that host's, and
   * waits for it.
   */
  awaitHost: (paneId: string, hostId: string) => void;
  /**
   * The panes waiting for `hostId` that `include` accepts, which stop
   * waiting: the caller is about to (re)create them.
   */
  takePanesAwaitingHost: (
    hostId: string,
    include?: (paneId: string) => boolean,
  ) => string[];
  /** Remount `paneIds`' terminals so they create/attach again. */
  reattach: (paneIds: readonly string[]) => void;
  /**
   * Whether this mount of `paneId` is a reattach (see `reattach`). One-shot:
   * the mount that asks takes it, so a later remount for any other reason is
   * an ordinary one again.
   */
  consumeReattach: (paneId: string) => boolean;
  /** Drop everything known about `paneId`: it was closed or left the window. */
  forgetPane: (paneId: string) => void;
}

/** `panes` with `paneId`'s entry changed — dropped once it holds nothing. */
function withPane(
  panes: Record<string, RemotePane>,
  paneId: string,
  change: Partial<RemotePane>,
): Record<string, RemotePane> {
  const next = { ...(panes[paneId] ?? NO_PANE), ...change };
  const { [paneId]: _, ...rest } = panes;
  const empty =
    next.hostId === null &&
    !next.awaiting &&
    next.reattachEpoch === 0 &&
    !next.reattachPending;
  return empty ? rest : { ...rest, [paneId]: next };
}

export const useRemotePaneStore = create<RemotePaneState>((set, get) => ({
  panes: {},

  setPaneHost: (paneId, hostId) =>
    set((state) => {
      const remote = hostId && hostId !== LOCAL_HOST_ID ? hostId : null;
      const pane = state.panes[paneId] ?? NO_PANE;
      if (pane.hostId === remote && !pane.awaiting) return state;
      return { panes: withPane(state.panes, paneId, { hostId: remote, awaiting: false }) };
    }),

  awaitHost: (paneId, hostId) =>
    set((state) => {
      const pane = state.panes[paneId];
      if (pane?.hostId === hostId && pane.awaiting) return state;
      return { panes: withPane(state.panes, paneId, { hostId, awaiting: true }) };
    }),

  takePanesAwaitingHost: (hostId, include = () => true) => {
    const taken = Object.entries(get().panes)
      .filter(([paneId, pane]) => pane.awaiting && pane.hostId === hostId && include(paneId))
      .map(([paneId]) => paneId);
    if (taken.length > 0) {
      set((state) => {
        let panes = state.panes;
        for (const paneId of taken) panes = withPane(panes, paneId, { awaiting: false });
        return { panes };
      });
    }
    return taken;
  },

  reattach: (paneIds) => {
    if (paneIds.length === 0) return;
    set((state) => {
      let panes = state.panes;
      for (const paneId of paneIds) {
        panes = withPane(panes, paneId, {
          reattachEpoch: (panes[paneId]?.reattachEpoch ?? 0) + 1,
          reattachPending: true,
        });
      }
      return { panes };
    });
  },

  consumeReattach: (paneId) => {
    if (!get().panes[paneId]?.reattachPending) return false;
    set((state) => ({
      panes: withPane(state.panes, paneId, { reattachPending: false }),
    }));
    return true;
  },

  forgetPane: (paneId) =>
    set((state) => {
      if (!(paneId in state.panes)) return state;
      const { [paneId]: _, ...rest } = state.panes;
      return { panes: rest };
    }),
}));

/** The remote host `paneId` runs on (or awaits), or undefined for a local pane. */
export function paneRemoteHost(
  state: Pick<RemotePaneState, "panes">,
  paneId: string,
): string | undefined {
  return state.panes[paneId]?.hostId ?? undefined;
}

/** Every remote pane and the host it runs on (or awaits). */
export function remoteHostByPane(
  state: Pick<RemotePaneState, "panes">,
): Record<string, string> {
  const byPane: Record<string, string> = {};
  for (const [paneId, pane] of Object.entries(state.panes)) {
    if (pane.hostId) byPane[paneId] = pane.hostId;
  }
  return byPane;
}

/**
 * The remote host any pane of a tab runs on, or `null` when every pane is
 * local (or unknown). Returns a primitive so a subscriber re-renders only when
 * the answer itself changes.
 */
export function selectTabRemoteHostId(
  rootNode: PaneNode,
): (state: Pick<RemotePaneState, "panes">) => string | null {
  return (state) => {
    for (const paneId of allPaneIds(rootNode)) {
      const hostId = state.panes[paneId]?.hostId;
      if (hostId) return hostId;
    }
    return null;
  };
}
