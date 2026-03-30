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
  const lastSlash = file.path.lastIndexOf("/");
  const name = lastSlash === -1 ? file.path : file.path.slice(lastSlash + 1);
  const dir = lastSlash === -1 ? "" : file.path.slice(0, lastSlash + 1);

  return (
    <div
      className={[styles.fileHeader, animated ? styles.headerAnimated : undefined].filter(Boolean).join(" ")}
      onClick={onToggle}
    >
      <span className={`${styles.chevron} ${collapsed ? "" : styles.chevronOpen}`}>
        <ChevronRight size={12} />
      </span>
      <span className={styles.filePath}>
        <span className={styles.fileName}>{name}</span>
        {dir && <span className={styles.fileDir}>{dir}</span>}
      </span>
      <span className={styles.fileStats}>
        {file.added > 0 && <span className={styles.statAdded}>+{file.added}</span>}
        {file.removed > 0 && <span className={styles.statRemoved}>-{file.removed}</span>}
      </span>
    </div>
  );
}
