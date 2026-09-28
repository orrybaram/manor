// Sidebar workspace multi-select (ADR-190 §1). Selection is per project — a
// selection in one project has no valid bulk "Move to Folder" or drag target
// in another, so picking a row elsewhere replaces it outright rather than
// merging with it.
//
// The anchor is the row a shift-click range is measured from. A plain click
// (`setAnchor`) and a modifier click (`toggle`) both move it; a shift-click
// (`selectRange`) never does, so repeated shift-clicks extend or shrink the
// same range instead of walking it forward.

import { create } from "zustand";

interface SidebarSelectionState {
  projectId: string | null;
  paths: Set<string>;
  anchorPath: string | null;

  /** Plain click: clears the selection and sets the anchor to `path`. */
  setAnchor: (projectId: string, path: string) => void;
  /**
   * Cmd/Ctrl+click: toggles `path` in the selection and moves the anchor to
   * it. A click in a different project starts a fresh one-row selection
   * rather than toggling against the old project's set.
   */
  toggle: (projectId: string, path: string) => void;
  /**
   * Shift+click: selects the contiguous range of `orderedVisiblePaths`
   * between the anchor and `toPath`. `fallbackAnchor` (the active workspace)
   * stands in when there is no anchor in this project yet, and `toPath`
   * itself stands in when neither is on screen.
   */
  selectRange: (
    projectId: string,
    orderedVisiblePaths: string[],
    toPath: string,
    fallbackAnchor: string | null,
  ) => void;
  /** Escape, or a click on empty sidebar space. */
  clear: () => void;
  /** Drops paths `existingPaths` no longer has, e.g. after a delete or hide. */
  prune: (projectId: string, existingPaths: ReadonlySet<string>) => void;
}

/** A stable empty set so a mismatched-project read never allocates. */
export const EMPTY_SIDEBAR_SELECTION: ReadonlySet<string> = new Set();

export const useSidebarSelectionStore = create<SidebarSelectionState>(
  (set) => ({
    projectId: null,
    paths: new Set(),
    anchorPath: null,

    setAnchor: (projectId, path) =>
      set({ projectId, paths: new Set(), anchorPath: path }),

    toggle: (projectId, path) =>
      set((s) => {
        if (s.projectId !== projectId) {
          return { projectId, paths: new Set([path]), anchorPath: path };
        }
        const paths = new Set(s.paths);
        if (paths.has(path)) paths.delete(path);
        else paths.add(path);
        return { projectId, paths, anchorPath: path };
      }),

    selectRange: (projectId, orderedVisiblePaths, toPath, fallbackAnchor) =>
      set((s) => {
        const anchorCandidate =
          s.projectId === projectId &&
            s.anchorPath !== null &&
            orderedVisiblePaths.includes(s.anchorPath)
            ? s.anchorPath
            : fallbackAnchor;
        const anchor =
          anchorCandidate !== null &&
            orderedVisiblePaths.includes(anchorCandidate)
            ? anchorCandidate
            : toPath;

        const anchorIdx = orderedVisiblePaths.indexOf(anchor);
        const toIdx = orderedVisiblePaths.indexOf(toPath);
        if (anchorIdx === -1 || toIdx === -1) {
          return { projectId, paths: new Set([toPath]), anchorPath: toPath };
        }
        const [start, end] =
          anchorIdx <= toIdx ? [anchorIdx, toIdx] : [toIdx, anchorIdx];
        return {
          projectId,
          paths: new Set(orderedVisiblePaths.slice(start, end + 1)),
          anchorPath: anchor,
        };
      }),

    clear: () => set({ projectId: null, paths: new Set(), anchorPath: null }),

    prune: (projectId, existingPaths) =>
      set((s) => {
        if (s.projectId !== projectId) return s;
        const next = new Set(
          [...s.paths].filter((path) => existingPaths.has(path)),
        );
        if (next.size === s.paths.size) return s;
        return { ...s, paths: next };
      }),
  }),
);
