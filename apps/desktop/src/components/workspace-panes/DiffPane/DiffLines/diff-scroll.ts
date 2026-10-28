import { createContext } from "react";

/**
 * What one file's `DiffLines` lets the pane do with rows that may not be
 * built: only the rows near the screen exist, so anything that wants a row
 * far away first asks its file to scroll there.
 */
export type DiffLinesHandle = {
  /** Scroll so row `index` is built and centred. */
  scrollToRow: (index: number) => void;
  /**
   * If search match `match` (counted across the whole diff) is in this file,
   * scroll to its row and return true; otherwise return false.
   */
  scrollToMatch: (match: number) => boolean;
};

/**
 * The pane's scroll container, shared by every file's rows.
 *
 * The files stack inside one scroller, so each `DiffLines` virtualizes
 * against that element, offset by where its own list starts. `watch` holds
 * the elements whose resizing can move that start: the pane's header, and
 * the stack of files. `handles` is how the pane reaches a
 * file's rows by index.
 */
export type DiffScroll = {
  scroller: HTMLElement | null;
  watch: readonly HTMLElement[];
  handles: Map<string, DiffLinesHandle>;
};

export const DiffScrollContext = createContext<DiffScroll>({
  scroller: null,
  watch: [],
  handles: new Map(),
});
