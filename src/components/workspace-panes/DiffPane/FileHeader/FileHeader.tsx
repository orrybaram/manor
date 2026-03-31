import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import type { DiffFile } from "../types";
import { AnimatedCount } from "../../../ui/AnimatedCount/AnimatedCount";
import styles from "./FileHeader.module.css";

type FileHeaderProps = {
  file: DiffFile;
  collapsed: boolean;
  animated?: boolean;
  onToggle: () => void;
};

export function FileHeader(props: FileHeaderProps) {
  const { file, collapsed, animated, onToggle } = props;
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
        {file.added > 0 && <AnimatedCount value={file.added} prefix="+" className={styles.statAdded} />}
        {file.removed > 0 && <AnimatedCount value={file.removed} prefix="-" className={styles.statRemoved} />}
      </span>
    </div>
  );
}
