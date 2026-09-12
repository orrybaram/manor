import { useMemo, useRef, useCallback } from "react";
import type { ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { DiffLine } from "../types";
import type { DraftComment } from "../../../../store/review-store";
import { extToLang, tokenize } from "../syntax";
import { highlightSyntaxNodes, highlightText } from "./hast-utils";
import { countMatches } from "../search-utils";
import { DiffCommentCard } from "../DiffCommentCard/DiffCommentCard";
import { anchorComments } from "./anchor-comments";
import styles from "./DiffLines.module.css";

type DiffLinesProps = {
  lines: DiffLine[];
  filePath: string;
  searchQuery: string;
  matchOffset: number;
  currentMatch: number;
  /** Draft review comments for THIS file, anchored by index into `lines`. */
  comments?: DraftComment[];
  editingId?: string | null;
  /** Comment to flash, after the review bar's jump list scrolls to it. */
  flashCommentId?: string | null;
  onSaveComment?: (id: string, body: string) => void;
  onCancelComment?: (id: string) => void;
  onEditComment?: (id: string) => void;
  onDeleteComment?: (id: string) => void;
};

const ROW_HEIGHT_ESTIMATE = 20;

/** Stable empty list so a file with no review keeps one memo identity. */
const NO_COMMENTS: DraftComment[] = [];

export function DiffLines(props: DiffLinesProps) {
  const {
    lines,
    filePath,
    searchQuery,
    matchOffset,
    currentMatch,
    comments = NO_COMMENTS,
    editingId = null,
    flashCommentId = null,
    onSaveComment,
    onCancelComment,
    onEditComment,
    onDeleteComment,
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

  const { byEnd, spanned } = useMemo(
    () => anchorComments(comments, lines.length),
    [comments, lines.length],
  );

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
   * The cards for one row, or `null`. They are returned as a third child of
   * the row rather than being folded into the content cell for two reasons:
   * the row is the element `measureElement` watches, so a card inside it is
   * measured for free; and `review-anchor` reads a row's line number and code
   * off its first two children, so nothing may be inserted before them.
   */
  const commentsForRow = (index: number): ReactNode => {
    const rowComments = byEnd.get(index);
    if (!rowComments) return null;
    return (
      <div className={styles.commentColumn}>
        {rowComments.map((comment) => (
          <DiffCommentCard
            key={comment.id}
            comment={comment}
            editing={editingId === comment.id}
            flash={flashCommentId === comment.id}
            onSave={(body) => onSaveComment?.(comment.id, body)}
            onCancel={() => onCancelComment?.(comment.id)}
            onEdit={() => onEditComment?.(comment.id)}
            onDelete={() => onDeleteComment?.(comment.id)}
          />
        ))}
      </div>
    );
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
          const rowComments = commentsForRow(i);
          const rowClass =
            rowComments === null
              ? styles.row
              : `${styles.row} ${styles.rowWithComment}`;
          const commented = spanned.has(i) ? "true" : undefined;

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
                {rowComments}
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
              {rowComments}
            </div>
          );
        })}
      </div>
    </div>
  );
}
