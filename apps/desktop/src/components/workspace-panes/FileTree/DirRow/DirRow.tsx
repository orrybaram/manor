import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down";
import { treeRowIndent } from "../indent";
import styles from "./DirRow.module.css";

type DirRowProps = {
  name: string;
  depth: number;
  collapsed: boolean;
  onToggle: () => void;
};

/** A folder row in a file tree: chevron and (possibly compressed) name. */
export function DirRow({ name, depth, collapsed, onToggle }: DirRowProps) {
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  return (
    <button
      type="button"
      className={styles.dirRow}
      style={{ paddingLeft: treeRowIndent(depth) }}
      onClick={onToggle}
    >
      <Chevron size={12} className={styles.dirChevron} />
      <span className={styles.dirName}>{name}</span>
    </button>
  );
}
