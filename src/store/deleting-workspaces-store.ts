// Workspaces whose removal is in flight, dimmed in the sidebar until they are
// gone. Shared rather than per project item because a bulk delete started in
// one host section of a linked group also removes rows in its other sections
// (ADR-192 ticket 7). Keyed by `selectionKey(projectId, path)`, so the same
// path on two hosts dims only the row being removed.
//
// A key is marked before its removal starts and unmarked once the removal
// settles. Marks are counted, so overlapping removals of one row keep it dim
// until the last of them settles. A removal resolves only after the project
// list has been refreshed, so a removed row is already gone when it is
// unmarked, and a failed one — still in the list — comes back undimmed.

import { create } from "zustand";

interface DeletingWorkspacesState {
  /** Keys with at least one removal in flight. */
  keys: ReadonlySet<string>;
  /**
   * In-flight removals per key. A single delete and a bulk delete can both be
   * removing the same row; it stays dimmed until the last of them settles.
   */
  counts: ReadonlyMap<string, number>;
  mark: (keys: string[]) => void;
  unmark: (keys: string[]) => void;
}

export const useDeletingWorkspacesStore = create<DeletingWorkspacesState>(
  (set) => ({
    keys: new Set(),
    counts: new Map(),
    mark: (keys) =>
      set((s) => {
        const counts = new Map(s.counts);
        for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
        return { counts, keys: new Set(counts.keys()) };
      }),
    unmark: (keys) =>
      set((s) => {
        const counts = new Map(s.counts);
        for (const key of keys) {
          const left = (counts.get(key) ?? 0) - 1;
          if (left > 0) counts.set(key, left);
          else counts.delete(key);
        }
        return { counts, keys: new Set(counts.keys()) };
      }),
  }),
);
