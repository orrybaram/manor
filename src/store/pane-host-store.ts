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

export const usePaneHostStore = create<PaneHostState>((set) => ({
  remoteHostByPane: {},

  setPaneHost: (paneId, hostId) =>
    set((state) => {
      if (!hostId || hostId === LOCAL_HOST_ID) {
        if (!(paneId in state.remoteHostByPane)) return state;
        const { [paneId]: _, ...rest } = state.remoteHostByPane;
        return { remoteHostByPane: rest };
      }
      if (state.remoteHostByPane[paneId] === hostId) return state;
      return { remoteHostByPane: { ...state.remoteHostByPane, [paneId]: hostId } };
    }),

  forgetPane: (paneId) =>
    set((state) => {
      if (!(paneId in state.remoteHostByPane)) return state;
      const { [paneId]: _, ...rest } = state.remoteHostByPane;
      return { remoteHostByPane: rest };
    }),
}));

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
