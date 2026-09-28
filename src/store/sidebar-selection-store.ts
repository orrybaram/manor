// Sidebar workspace multi-select (ADR-190 §1). Selection is per scope — a
// lone project, or a linked group whose host sections share one selection
// (ADR-192 ticket 7). A selection in one scope has no valid bulk action or
// drag target in another, so picking a row elsewhere replaces it outright
// rather than merging with it.
//
// Entries are opaque keys — `selectionKey(projectId, path)` from
// `utils/sidebar-items` — so the same path on two hosts of one group is two
// rows, and every entry names the member project that owns it.
//
// The anchor is the row a shift-click range is measured from. A plain click
// (`setAnchor`) and a modifier click (`toggle`) both move it; a shift-click
// (`selectRange`) never does, so repeated shift-clicks extend or shrink the
// same range instead of walking it forward.

import { create } from "zustand";

interface SidebarSelectionState {
  /** The project id, or the group id for a linked group's sections. */
  scopeId: string | null;
  keys: Set<string>;
  anchorKey: string | null;
  /**
   * True while the anchor comes from a plain click, i.e. it is the row the
   * user is on rather than one they just toggled off — only then may a
   * Cmd/Ctrl-click take it along.
   */
  anchorClicked: boolean;

  /** Plain click: clears the selection and sets the anchor to `key`. */
  setAnchor: (scopeId: string, key: string) => void;
  /**
   * Cmd/Ctrl+click: toggles `key` in the selection and moves the anchor to
   * it. A click in a different scope starts a fresh one-row selection rather
   * than toggling against the old scope's set.
   *
   * Starting a selection takes the row the user was already on with it — a
   * plain click's anchor, else `fallbackAnchor` (the active workspace) when
   * there is no anchor at all — so click-then-Cmd/Ctrl-click selects both, as
   * in a file manager. A row toggled off is never brought back.
   */
  toggle: (scopeId: string, key: string, fallbackAnchor?: string | null) => void;
  /**
   * Shift+click: selects the contiguous range of `orderedVisibleKeys`
   * between the anchor and `toKey`. `fallbackAnchor` (the active workspace)
   * stands in when there is no anchor in this scope yet, and `toKey` itself
   * stands in when neither is on screen.
   */
  selectRange: (
    scopeId: string,
    orderedVisibleKeys: string[],
    toKey: string,
    fallbackAnchor: string | null,
  ) => void;
  /** Escape, or a click on empty sidebar space. */
  clear: () => void;
}

/** A stable empty set so a mismatched-scope read never allocates. */
export const EMPTY_SIDEBAR_SELECTION: ReadonlySet<string> = new Set();

export const useSidebarSelectionStore = create<SidebarSelectionState>(
  (set) => ({
    scopeId: null,
    keys: new Set(),
    anchorKey: null,
    anchorClicked: false,

    setAnchor: (scopeId, key) =>
      set({ scopeId, keys: new Set(), anchorKey: key, anchorClicked: true }),

    toggle: (scopeId, key, fallbackAnchor = null) =>
      set((s) => {
        const sameScope = s.scopeId === scopeId;
        const keys = sameScope ? new Set(s.keys) : new Set<string>();
        if (keys.size === 0) {
          const anchor = sameScope ? s.anchorKey : null;
          const seed =
            anchor === null ? fallbackAnchor : s.anchorClicked ? anchor : null;
          if (seed !== null && seed !== key) keys.add(seed);
        }
        if (keys.has(key)) keys.delete(key);
        else keys.add(key);
        return { scopeId, keys, anchorKey: key, anchorClicked: false };
      }),

    selectRange: (scopeId, orderedVisibleKeys, toKey, fallbackAnchor) =>
      set((s) => {
        const anchorCandidate =
          s.scopeId === scopeId &&
            s.anchorKey !== null &&
            orderedVisibleKeys.includes(s.anchorKey)
            ? s.anchorKey
            : fallbackAnchor;
        const anchor =
          anchorCandidate !== null &&
            orderedVisibleKeys.includes(anchorCandidate)
            ? anchorCandidate
            : toKey;

        const anchorIdx = orderedVisibleKeys.indexOf(anchor);
        const toIdx = orderedVisibleKeys.indexOf(toKey);
        if (anchorIdx === -1 || toIdx === -1) {
          return {
            scopeId,
            keys: new Set([toKey]),
            anchorKey: toKey,
            anchorClicked: false,
          };
        }
        const [start, end] =
          anchorIdx <= toIdx ? [anchorIdx, toIdx] : [toIdx, anchorIdx];
        return {
          scopeId,
          keys: new Set(orderedVisibleKeys.slice(start, end + 1)),
          anchorKey: anchor,
          anchorClicked: false,
        };
      }),

    clear: () =>
      set({
        scopeId: null,
        keys: new Set(),
        anchorKey: null,
        anchorClicked: false,
      }),
  }),
);
