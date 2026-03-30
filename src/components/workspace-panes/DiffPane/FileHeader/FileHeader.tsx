import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import type { DiffFile } from "../types";
import styles from "./FileHeader.module.css";

export function FileHeader({
  file,
  collapsed,
  animated,
  onToggle,
}: {
  file: DiffFile;
  collapsed: boolean;
  animated?: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      className={[styles.fileHeader, animated ? styles.headerAnimated : undefined].filter(Boolean).join(" ")}
      onClick={onToggle}
    >
      <span className={`${styles.chevron} ${collapsed ? "" : styles.chevronOpen}`}>
        <ChevronRight size={12} />
      </span>
      <span className={styles.fileName}>{file.path}</span>
      <span className={styles.fileStats}>
        {file.added > 0 && <span className={styles.statAdded}>+{file.added}</span>}
        {file.removed > 0 && <span className={styles.statRemoved}>-{file.removed}</span>}
      </span>
    </div>
  );
}
