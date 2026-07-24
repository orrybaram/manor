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
  goBack: () => Location | null;
  goForward: () => Location | null;
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

    goBack: () => {
      const { entries, index } = get();
      if (index <= 0) return null;
      const nextIndex = index - 1;
      set({ index: nextIndex });
      return entries[nextIndex];
    },

    goForward: () => {
      const { entries, index } = get();
      if (index >= entries.length - 1) return null;
      const nextIndex = index + 1;
      set({ index: nextIndex });
      return entries[nextIndex];
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
