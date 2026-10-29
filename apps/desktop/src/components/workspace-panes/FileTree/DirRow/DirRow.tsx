import type { ReactNode } from "react";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down";
import { treeRowIndent } from "../indent";
import styles from "./DirRow.module.css";

type DirRowProps = {
  name: string;
  depth: number;
  collapsed: boolean;
  onToggle: () => void;
  /** Shown at the row's right end: the file pane's dot for a folder holding changes. */
  trailing?: ReactNode;
  /** -1 where the tree, not its rows, takes Tab. */
  tabIndex?: number;
};

/** A folder row in a file tree: chevron and (possibly compressed) name. */
export function DirRow({ name, depth, collapsed, onToggle, trailing, tabIndex }: DirRowProps) {
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  return (
    <button
      type="button"
      className={styles.dirRow}
      style={{ paddingLeft: treeRowIndent(depth) }}
      tabIndex={tabIndex}
      onClick={onToggle}
    >
      <Chevron size={12} className={styles.dirChevron} />
      <span className={styles.dirName}>{name}</span>
      {trailing !== undefined && <span className={styles.trailing}>{trailing}</span>}
    </button>
  );
}
