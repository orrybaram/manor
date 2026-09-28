// Workspaces whose removal is in flight, dimmed in the sidebar until they are
// gone. Shared rather than per project item because a bulk delete started in
// one host section of a linked group also removes rows in its other sections
// (ADR-192 ticket 7). Keyed by `selectionKey(projectId, path)`, so the same
// path on two hosts dims only the row being removed.
//
// A key is marked before its removal starts and unmarked once the removal
// settles. A removal resolves only after the project list has been refreshed,
// so a removed row is already gone when it is unmarked, and a failed one —
// still in the list — comes back undimmed.

import { create } from "zustand";

interface DeletingWorkspacesState {
  keys: ReadonlySet<string>;
  mark: (keys: string[]) => void;
  unmark: (keys: string[]) => void;
}

export const useDeletingWorkspacesStore = create<DeletingWorkspacesState>(
  (set) => ({
    keys: new Set(),
    mark: (keys) =>
      set((s) => ({ keys: new Set([...s.keys, ...keys]) })),
    unmark: (keys) =>
      set((s) => {
        const next = new Set(s.keys);
        for (const key of keys) next.delete(key);
        return { keys: next };
      }),
  }),
);
