import { create } from "zustand";

/**
 * Which terminal panes must drop their xterm and create/attach their session
 * again (ADR-178 §6). A pane's `TerminalPane` is keyed by its epoch here, so
 * bumping it remounts the pane and runs the ordinary create/attach path:
 *
 * - a session that survived its remote host's drop comes back through its
 *   warm-restore snapshot — the output it printed while the host was away
 *   was never delivered, so the old screen is stale;
 * - a session the host lost (its daemon restarted) is created afresh in the
 *   pane's cwd, running whatever command was queued for the pane.
 *
 * Local-only users never touch this store.
 */
interface PaneReattachState {
  epochByPane: Record<string, number>;
  /** Remount `paneIds`' terminals so they create/attach again. */
  reattach: (paneIds: readonly string[]) => void;
}

/** Panes whose next mount is a reattach, not a user opening them. */
const pendingReattach = new Set<string>();

export const usePaneReattachStore = create<PaneReattachState>((set) => ({
  epochByPane: {},

  reattach: (paneIds) => {
    if (paneIds.length === 0) return;
    for (const paneId of paneIds) pendingReattach.add(paneId);
    set((state) => {
      const next = { ...state.epochByPane };
      for (const paneId of paneIds) next[paneId] = (next[paneId] ?? 0) + 1;
      return { epochByPane: next };
    });
  },
}));

/**
 * Whether this mount of `paneId` is a reattach (see `reattach`). One-shot:
 * the mount that asks takes it, so a later remount for any other reason is
 * an ordinary one again.
 */
export function consumeReattach(paneId: string): boolean {
  return pendingReattach.delete(paneId);
}
