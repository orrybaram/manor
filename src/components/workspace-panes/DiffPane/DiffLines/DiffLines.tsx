import { memo, useMemo, useRef, useCallback } from "react";
import type { ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { DiffLine } from "../types";
import { extToLang, tokenize } from "../syntax";
import { highlightSyntaxNodes, highlightText } from "./hast-utils";
import { countMatches } from "../search-utils";
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
  const parentRef = useRef<HTMLDivElement>(null);

  const tokenizedLines = useMemo(() => {
    const lang = extToLang(filePath);
    if (!lang) return null;
    return lines.map((line) => {
      if (line.type === "hunk") return null;
      return tokenize(line.content, lang);
    });
  }, [lines, filePath]);

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

  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => lines.length * ROW_HEIGHT_ESTIMATE,
    overscan: 30,
  });

  const measureRef = useCallback(
    (el: HTMLDivElement | null) => {
      if (el) virtualizer.measureElement(el);
    },
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
    <div ref={parentRef} className={styles.scrollContainer}>
      <div
        className={styles.virtualList}
        data-diff-lines
        style={{ height: virtualizer.getTotalSize() }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => {
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
                  transform: `translateY(${virtualRow.start}px)`,
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

          const tokens = tokenizedLines?.[i];
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
                transform: `translateY(${virtualRow.start}px)`,
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
