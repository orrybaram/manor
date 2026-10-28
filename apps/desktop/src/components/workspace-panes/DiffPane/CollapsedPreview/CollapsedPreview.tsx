import { useMemo } from "react";
import type { DiffFile } from "../types";
import rowStyles from "../DiffLines/DiffLines.module.css";
import styles from "./CollapsedPreview.module.css";

/** Rows shown above the fade: enough to tell what kind of change it is. */
const PREVIEW_ROWS = 4;

type CollapsedPreviewProps = {
  file: DiffFile;
  onExpand: () => void;
};

/**
 * What a file that starts collapsed shows instead of its rows: its first few
 * lines fading out, and a bar that expands it. Plain text and no row indices,
 * so it never takes part in search, selection or review.
 */
export function CollapsedPreview(props: CollapsedPreviewProps) {
  const { file, onExpand } = props;
  const code = useMemo(
    () => file.lines.filter((line) => line.type !== "hunk"),
    [file.lines],
  );
  // A binary or renamed-only file has no lines to preview or show.
  if (code.length === 0) return null;
  const shown = code.slice(0, PREVIEW_ROWS);

  return (
    <div className={styles.preview}>
      <div className={styles.rows} aria-hidden="true">
        {shown.map((line, i) => {
          const num = line.type === "del" ? line.oldNum : line.newNum;
          const numClass =
            line.type === "add"
              ? rowStyles.lineNumAdd
              : line.type === "del"
                ? rowStyles.lineNumDel
                : rowStyles.lineNum;
          const contentClass =
            line.type === "add"
              ? rowStyles.lineContentAdd
              : line.type === "del"
                ? rowStyles.lineContentDel
                : rowStyles.lineContent;
          const prefix =
            line.type === "add" ? "+" : line.type === "del" ? "-" : " ";
          return (
            <div key={i} className={styles.row}>
              <div className={numClass}>{num}</div>
              <div className={contentClass}>
                <span className={rowStyles.prefix}>{prefix}</span>
                {line.content}
              </div>
            </div>
          );
        })}
      </div>
      <button type="button" className={styles.showAll} onClick={onExpand}>
        Show all {code.length.toLocaleString("en")} lines
      </button>
    </div>
  );
}
