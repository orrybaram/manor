import { create } from "zustand";

/** Where a file pane's editor is among its file's agent edits. */
export type EditNav = {
  /** How many runs of agent-changed lines the open file has. */
  count: number;
  /** The one last jumped to, 0-based; null before the first jump. */
  current: number | null;
};

type EditNavStore = {
  byPane: Record<string, EditNav>;
  set: (paneId: string, nav: EditNav | null) => void;
};

/**
 * Each file pane's edit count and position, which its editor writes and the
 * pane header's jump control reads: the two live in different trees.
 */
export const useFileEditNav = create<EditNavStore>((set) => ({
  byPane: {},
  set: (paneId, nav) =>
    set((s) => {
      const prev = s.byPane[paneId];
      if (nav === null) {
        if (!prev) return s;
        const { [paneId]: _gone, ...rest } = s.byPane;
        return { byPane: rest };
      }
      if (prev && prev.count === nav.count && prev.current === nav.current) return s;
      return { byPane: { ...s.byPane, [paneId]: nav } };
    }),
}));

const jumpers = new Map<string, (direction: 1 | -1) => void>();

/** The pane's editor answers the header's ↑ and ↓; returns the unregister. */
export function registerEditJumper(
  paneId: string,
  jump: (direction: 1 | -1) => void,
): () => void {
  jumpers.set(paneId, jump);
  return () => {
    if (jumpers.get(paneId) === jump) jumpers.delete(paneId);
  };
}

/** Move the pane's editor to its next (1) or previous (-1) agent edit. */
export function jumpToEdit(paneId: string, direction: 1 | -1): void {
  jumpers.get(paneId)?.(direction);
}
