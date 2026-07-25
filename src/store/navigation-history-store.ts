import { create } from "zustand";

/**
 * A single navigable location in the app. Coarse granularity — no `paneId`.
 *
 * This type deliberately avoids importing anything from `app-store` to
 * prevent a circular dependency: `app-store` (or a bridge that sits on top
 * of it) is expected to translate its own state into a `Location` and feed
 * it into this store via `record`.
 */
export type Location =
  | { kind: "surface"; surface: "home" }
  | { kind: "workspace"; workspacePath: string; panelId: string; tabId: string };

export function locationsEqual(a: Location, b: Location): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "surface" && b.kind === "surface") {
    return a.surface === b.surface;
  }
  if (a.kind === "workspace" && b.kind === "workspace") {
    return (
      a.workspacePath === b.workspacePath &&
      a.panelId === b.panelId &&
      a.tabId === b.tabId
    );
  }
  return false;
}

interface NavigationHistoryState {
  entries: Location[];
  index: number;
  isNavigating: boolean;

  record: (loc: Location) => void;
  /**
   * Walk history by `dir` (-1 = back, +1 = forward) to the first entry
   * `isValid` accepts, pruning any stale entries passed along the way, and
   * move the index to it. Returns that entry, or `null` if a direction's end
   * is reached with nothing valid. This is the sole mutator of `index`/`entries`
   * during navigation — the predicate is how layout validity crosses in without
   * this store importing `app-store`.
   */
  navigate: (dir: -1 | 1, isValid: (loc: Location) => boolean) => Location | null;
  canGoBack: () => boolean;
  canGoForward: () => boolean;
  reset: () => void;
  setNavigating: (v: boolean) => void;
}

export const useNavigationHistoryStore = create<NavigationHistoryState>(
  (set, get) => ({
    entries: [],
    index: -1,
    isNavigating: false,

    record: (loc) => {
      const { entries, index } = get();
      const current = index >= 0 ? entries[index] : undefined;
      if (current && locationsEqual(current, loc)) {
        return;
      }

      const truncated = entries.slice(0, index + 1);
      const nextEntries = [...truncated, loc];
      set({ entries: nextEntries, index: nextEntries.length - 1 });
    },

    navigate: (dir, isValid) => {
      let { entries, index } = get();
      for (;;) {
        const nextIndex = index + dir;
        if (nextIndex < 0 || nextIndex >= entries.length) {
          // Hit an end of history with nothing valid; persist any prunes.
          set({ entries, index });
          return null;
        }
        const candidate = entries[nextIndex];
        if (isValid(candidate)) {
          set({ entries, index: nextIndex });
          return candidate;
        }
        // Stale entry: drop it and retry in the same direction. Removing the
        // entry at `nextIndex` shifts later indices down by one, so the current
        // `index` only moves when it sat after the removed entry.
        entries = entries.filter((_, i) => i !== nextIndex);
        if (index > nextIndex) index -= 1;
      }
    },

    canGoBack: () => get().index > 0,
    canGoForward: () => {
      const { entries, index } = get();
      return index < entries.length - 1;
    },

    reset: () => {
      set({ entries: [], index: -1 });
    },

    setNavigating: (v) => {
      set({ isNavigating: v });
    },
  }),
);
