import { create } from "zustand";
import { LOCAL_HOST_ID } from "../lib/hosts";
import { allPaneIds, type PaneNode } from "./pane-tree";

/**
 * The host each pane's session ACTUALLY runs on (ADR-160), as reported by
 * main when `pty:create` / `pty:reset` resolves.
 *
 * This is deliberately not derived from the project's current `hostId`: a
 * project can be moved to another host while its panes keep running where
 * they started, and a tab must badge where its terminal really is.
 *
 * Only remote panes are recorded. A local pane — and a pane created before
 * main reported hosts — is simply absent, so local-only users never cause a
 * single update to this store (and so never re-render a subscriber).
 */
interface PaneHostState {
  remoteHostByPane: Record<string, string>;
  /** Record where `paneId`'s session runs. Local / unknown clears the entry. */
  setPaneHost: (paneId: string, hostId: string | undefined) => void;
  forgetPane: (paneId: string) => void;
}

/**
 * Panes with no session yet because their remote host was not connected
 * when they tried to create one (ADR-178 §6) — an app launched while the
 * host is down, or a pane opened on it meanwhile — and the host each
 * awaits. Their host is recorded in `remoteHostByPane` too, so they show the
 * host's offline banner; once the host connects they are remounted to
 * create their session then. Not reactive: nothing renders from it.
 */
const awaitingHostByPane = new Map<string, string>();

export const usePaneHostStore = create<PaneHostState>((set) => ({
  remoteHostByPane: {},

  setPaneHost: (paneId, hostId) => {
    awaitingHostByPane.delete(paneId);
    set((state) => {
      if (!hostId || hostId === LOCAL_HOST_ID) {
        if (!(paneId in state.remoteHostByPane)) return state;
        const { [paneId]: _, ...rest } = state.remoteHostByPane;
        return { remoteHostByPane: rest };
      }
      if (state.remoteHostByPane[paneId] === hostId) return state;
      return { remoteHostByPane: { ...state.remoteHostByPane, [paneId]: hostId } };
    });
  },

  forgetPane: (paneId) => {
    awaitingHostByPane.delete(paneId);
    set((state) => {
      if (!(paneId in state.remoteHostByPane)) return state;
      const { [paneId]: _, ...rest } = state.remoteHostByPane;
      return { remoteHostByPane: rest };
    });
  },
}));

/**
 * Record that `paneId` could not create its session because remote host
 * `hostId` is not connected: it badges and banners as that host's, and
 * waits for it (see `takePanesAwaitingHost`).
 */
export function awaitPaneHost(paneId: string, hostId: string): void {
  usePaneHostStore.getState().setPaneHost(paneId, hostId);
  awaitingHostByPane.set(paneId, hostId);
}

/** Whether `paneId` is waiting for its host to create its session. */
export function isAwaitingHost(paneId: string): boolean {
  return awaitingHostByPane.has(paneId);
}

/**
 * The panes waiting for `hostId` that `include` accepts, which stop
 * waiting: the caller is about to (re)create them.
 */
export function takePanesAwaitingHost(
  hostId: string,
  include: (paneId: string) => boolean = () => true,
): string[] {
  const taken: string[] = [];
  for (const [paneId, awaited] of awaitingHostByPane) {
    if (awaited !== hostId || !include(paneId)) continue;
    awaitingHostByPane.delete(paneId);
    taken.push(paneId);
  }
  return taken;
}

/**
 * The remote host any pane of a tab runs on, or `null` when every pane is
 * local (or unknown). Returns a primitive so a subscriber re-renders only when
 * the answer itself changes.
 */
export function selectTabRemoteHostId(
  rootNode: PaneNode,
): (state: Pick<PaneHostState, "remoteHostByPane">) => string | null {
  return (state) => {
    for (const paneId of allPaneIds(rootNode)) {
      const hostId = state.remoteHostByPane[paneId];
      if (hostId) return hostId;
    }
    return null;
  };
}
