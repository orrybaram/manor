import {
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ReactNode } from "react";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import type { Range } from "@tanstack/react-virtual";
import type { RootContent } from "hast";
import type { DiffLine } from "../types";
import {
  extToLang,
  loadedTokenizer,
  subscribeTokenizer,
  type Tokenize,
} from "../syntax";
import { highlightSyntaxNodes, highlightText } from "./hast-utils";
import { countMatches } from "../search-utils";
import { DiffScrollContext } from "./diff-scroll";
import { setRowSource } from "../review-anchor";
import styles from "./DiffLines.module.css";

type DiffLinesProps = {
  lines: DiffLine[];
  filePath: string;
  searchQuery: string;
  matchOffset: number;
  currentMatch: number;
  /**
   * Content to hang beneath row `index`, inside the row's own measured box.
   * Whatever it is belongs to the caller — this component only places it.
   */
  renderRowExtra?: (index: number) => ReactNode;
  /** Rows to mark as annotated, for a left accent and a faint wash. */
  markedRows?: ReadonlySet<number>;
};

const ROW_HEIGHT_ESTIMATE = 20;

/**
 * Rows past the screen to keep built, each way. Enough that a fast wheel
 * flick or a drag-selection's auto-scroll lands on rows already drawn.
 */
const OVERSCAN = 20;

/**
 * The list is not its own scroller: the files stack in the pane, and the pane
 * scrolls. So the rows virtualize against the pane's scroller, offset by
 * where this list starts in it (`scrollMargin`), and only the rows near the
 * screen are built.
 *
 * It used to build every row by giving the virtualizer an unbounded viewport,
 * which cost the window ~300MB per thousand changed lines. Before that, the
 * viewport was faked by estimating each row at the height of the whole file;
 * past ~1300 rows that exceeded the tallest box Chromium lays out and chained
 * re-renders past React's limit (error #185). Here row heights are only ever
 * measured, never inflated, so neither can happen.
 */
/**
 * The syntax highlighter, loaded the first time a file that has a grammar is
 * shown. Rows render as plain text until it arrives, then highlight in place.
 */
function noSubscription(): () => void {
  return () => {};
}

/** The highlighter, loading it on first use when `wanted`; `null` until then. */
function useTokenizer(wanted: boolean): Tokenize | null {
  return useSyncExternalStore(
    wanted ? subscribeTokenizer : noSubscription,
    loadedTokenizer,
  );
}

/** Stable empty set so a file with nothing to mark keeps one identity. */
const NO_MARKED_ROWS: ReadonlySet<number> = new Set();

/**
 * Memoized because it is expensive and its props usually have not changed.
 *
 * Anything that re-renders `DiffPane` — a poll settling, a file being staged,
 * the search box — otherwise rebuilds every row of every file, and a large
 * review is several thousand rows. The props are all stable across such a
 * render: `lines` comes from a `useMemo` over the raw diff, and the review
 * annotations from one over the drafts.
 */
export const DiffLines = memo(function DiffLines(props: DiffLinesProps) {
  const {
    lines,
    filePath,
    searchQuery,
    matchOffset,
    currentMatch,
    renderRowExtra,
    markedRows = NO_MARKED_ROWS,
  } = props;
  const listRef = useRef<HTMLDivElement>(null);
  const { scroller, watch, handles } = useContext(DiffScrollContext);

  const lang = extToLang(filePath);
  const tokenize = useTokenizer(lang !== null);

  // Highlighted as rows are built, not up front: a row that is never shown is
  // never tokenized, and its tokens are not held.
  const tokenCache = useMemo(
    () => new Map<number, RootContent[]>(),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a new cache whenever what it caches changes
    [lines, lang, tokenize],
  );
  const tokensFor = (i: number): RootContent[] | null => {
    if (!lang || !tokenize || lines[i].type === "hunk") return null;
    let tokens = tokenCache.get(i);
    if (!tokens) {
      tokens = tokenize(lines[i].content, lang);
      tokenCache.set(i, tokens);
    }
    return tokens;
  };

  // Where this list starts inside the pane's scrolled content. It moves when
  // anything above it changes height — a file expanding, rows measuring, the
  // file list above the files in a narrow pane — so it is re-read whenever
  // any of those resize. `null` until first measured: rows built against a
  // guessed offset would be measured in the wrong place and jolt the scroll.
  const [scrollMargin, setScrollMargin] = useState<number | null>(null);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!scroller || !list) return;
    const measure = () => {
      const top =
        list.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top +
        scroller.scrollTop;
      setScrollMargin((prev) =>
        prev !== null && Math.abs(prev - top) < 1 ? prev : top,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    for (const el of watch) observer.observe(el);
    return () => observer.disconnect();
  }, [scroller, watch]);

  // Pre-compute cumulative match counts so each row knows its offset
  const cumulativeMatches = useMemo(() => {
    if (!searchQuery) return null;
    const cumulative = new Array<number>(lines.length + 1);
    cumulative[0] = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const count =
        line.type === "hunk" ? 0 : countMatches(line.content, searchQuery);
      cumulative[i + 1] = cumulative[i] + count;
    }
    return cumulative;
  }, [lines, searchQuery]);

  // The rows holding the selection's two ends stay built however far the
  // pane scrolls from them. Unbuilding one would move that end of the
  // selection to whatever row took its place, and a copy or comment would
  // silently cover the wrong lines.
  const pinnedRows = useRef<readonly number[]>([]);
  const rangeExtractor = useCallback((range: Range) => {
    const indexes = defaultRangeExtractor(range);
    const extra = pinnedRows.current.filter(
      (i) => i < range.count && !indexes.includes(i),
    );
    return extra.length > 0
      ? [...indexes, ...extra].sort((a, b) => a - b)
      : indexes;
  }, []);
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    // An end in a row's code; not one in a comment card hung under the row,
    // which is typing or a button press rather than a selection of lines.
    const rowOf = (node: Node | null): number | null => {
      const el = node instanceof Element ? node : node?.parentElement;
      const row = el?.closest<HTMLElement>("[data-index]");
      if (!el || !row || !list.contains(row)) return null;
      if (!row.children[1]?.contains(el)) return null;
      return Number(row.dataset.index);
    };
    const onSelectionChange = () => {
      const sel = document.getSelection();
      pinnedRows.current =
        sel && sel.rangeCount > 0
          ? [rowOf(sel.anchorNode), rowOf(sel.focusNode)].filter(
              (i): i is number => i !== null,
            )
          : [];
    };
    document.addEventListener("selectionchange", onSelectionChange);
    return () =>
      document.removeEventListener("selectionchange", onSelectionChange);
  }, []);

  // Rows that are not built are still selectable text, as far as copying and
  // commenting go: their text is read from here.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    setRowSource(list, {
      count: lines.length,
      text: (i) => {
        const line = lines[i];
        if (!line) return null;
        if (line.type === "hunk") return line.content;
        const num = line.type === "del" ? line.oldNum : line.newNum;
        const prefix =
          line.type === "add" ? "+" : line.type === "del" ? "-" : " ";
        return num !== undefined
          ? `${num}: ${prefix}${line.content}`
          : `${prefix}${line.content}`;
      },
      lineNumber: (i) => {
        const line = lines[i];
        if (!line || line.type === "hunk") return "";
        const num = line.type === "del" ? line.oldNum : line.newNum;
        return num !== undefined ? String(num) : "";
      },
    });
    return () => setRowSource(list, null);
  }, [lines]);

  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scroller,
    estimateSize: () => ROW_HEIGHT_ESTIMATE,
    scrollMargin: scrollMargin ?? 0,
    overscan: OVERSCAN,
    rangeExtractor,
  });
  const margin = scrollMargin ?? 0;

  // The virtualizer keeps `OVERSCAN` rows at whichever end of the file is
  // nearest the screen, even when the whole file is far above or below it —
  // a few dozen rows for every file in the diff. Only rows actually near the
  // screen are built.
  const band = OVERSCAN * ROW_HEIGHT_ESTIMATE;
  const viewTop = (virtualizer.scrollOffset ?? 0) - band;
  const viewBottom =
    (virtualizer.scrollOffset ?? 0) +
    (virtualizer.scrollRect?.height ?? 0) +
    band;
  const nearScreen = (row: { index: number; start: number; end: number }) =>
    (row.end > viewTop && row.start < viewBottom) ||
    pinnedRows.current.includes(row.index);

  // The pane reaches rows that may not be built through this, by index.
  const latest = useRef({ virtualizer, cumulativeMatches, matchOffset });
  latest.current = { virtualizer, cumulativeMatches, matchOffset };
  useEffect(() => {
    handles.set(filePath, {
      scrollToRow: (index) =>
        latest.current.virtualizer.scrollToIndex(index, { align: "center" }),
      scrollToMatch: (match) => {
        const { cumulativeMatches: cum, matchOffset: offset } = latest.current;
        if (!cum) return false;
        const local = match - offset;
        if (local < 0 || local >= cum[cum.length - 1]) return false;
        // The row whose matches cover `local`: the last i with cum[i] <= local.
        let lo = 0;
        let hi = cum.length - 2;
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1;
          if (cum[mid] <= local) lo = mid;
          else hi = mid - 1;
        }
        latest.current.virtualizer.scrollToIndex(lo, { align: "center" });
        return true;
      },
    });
    return () => {
      handles.delete(filePath);
    };
  }, [handles, filePath]);

  // `null` too: that is how the virtualizer learns a row was unbuilt, and
  // stops holding (and observing) its element.
  const measureRef = useCallback(
    (el: HTMLDivElement | null) => virtualizer.measureElement(el),
    [virtualizer],
  );

  /**
   * Extra content is returned as a third child of the row rather than folded
   * into the content cell for two reasons: the row is the element
   * `measureElement` watches, so anything inside it is measured for free; and
   * `review-anchor` reads a row's line number and code off its first two
   * children, so nothing may be inserted before them.
   */
  const rowExtra = (index: number): ReactNode => {
    const extra = renderRowExtra?.(index);
    return extra ? <div className={styles.rowExtra}>{extra}</div> : null;
  };

  return (
    <div className={styles.scrollContainer}>
      <div
        ref={listRef}
        className={styles.virtualList}
        data-diff-lines
        style={{ height: virtualizer.getTotalSize() }}
      >
        {(scrollMargin === null
          ? []
          : virtualizer.getVirtualItems().filter(nearScreen)
        ).map((virtualRow) => {
          const i = virtualRow.index;
          const line = lines[i];
          const extra = rowExtra(i);
          const rowClass =
            extra === null
              ? styles.row
              : `${styles.row} ${styles.rowWithExtra}`;
          const commented = markedRows.has(i) ? "true" : undefined;

          if (line.type === "hunk") {
            return (
              <div
                key={virtualRow.key}
                ref={measureRef}
                data-index={i}
                data-commented={commented}
                className={rowClass}
                style={{
                  transform: `translateY(${virtualRow.start - margin}px)`,
                }}
              >
                <div className={styles.lineNum} />
                <div className={styles.hunkContent}>{line.content}</div>
                {extra}
              </div>
            );
          }

          const numClass =
            line.type === "add"
              ? styles.lineNumAdd
              : line.type === "del"
                ? styles.lineNumDel
                : styles.lineNum;
          const contentClass =
            line.type === "add"
              ? styles.lineContentAdd
              : line.type === "del"
                ? styles.lineContentDel
                : styles.lineContent;
          const num = line.type === "del" ? line.oldNum : line.newNum;
          const prefix =
            line.type === "add" ? "+" : line.type === "del" ? "-" : " ";

          let content: ReactNode[];
          const lineMatchOffset =
            cumulativeMatches != null
              ? matchOffset + cumulativeMatches[i]
              : matchOffset;

          const tokens = tokensFor(i);
          if (tokens) {
            const result = highlightSyntaxNodes(
              tokens,
              searchQuery,
              lineMatchOffset,
              currentMatch,
              `l${i}`,
            );
            content = result.elements;
          } else {
            const result = highlightText(
              line.content,
              searchQuery,
              lineMatchOffset,
              currentMatch,
            );
            content = result.fragments;
          }

          return (
            <div
              key={virtualRow.key}
              ref={measureRef}
              data-index={i}
              data-commented={commented}
              className={rowClass}
              style={{
                transform: `translateY(${virtualRow.start - margin}px)`,
              }}
            >
              <div className={numClass}>{num}</div>
              <div className={contentClass}>
                <span className={styles.prefix}>{prefix}</span>
                {content}
              </div>
              {extra}
            </div>
          );
        })}
      </div>
    </div>
  );
});
