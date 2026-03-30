import type { DiffFile } from "../types";
import styles from "./FileList.module.css";

export function FileList({
  files,
  onSelectFile,
  animationState,
}: {
  files: DiffFile[];
  onSelectFile: (path: string) => void;
  animationState: Map<string, "new" | "updated">;
}) {
  const totalAdded = files.reduce((s, f) => s + f.added, 0);
  const totalRemoved = files.reduce((s, f) => s + f.removed, 0);

  return (
    <div className={styles.fileList}>
      <div className={styles.fileListHeader}>
        {files.length} {files.length === 1 ? "file" : "files"} changed
        {totalAdded > 0 && <span className={styles.statAdded}> +{totalAdded}</span>}
        {totalRemoved > 0 && <span className={styles.statRemoved}> -{totalRemoved}</span>}
      </div>
      {files.map((file) => (
        <div
          key={file.path}
          className={[
            styles.fileListItem,
            animationState.get(file.path) === "new" ? styles.fileListItemNew : undefined,
            animationState.get(file.path) === "updated" ? styles.fileListItemUpdated : undefined,
          ].filter(Boolean).join(" ")}
          onClick={() => onSelectFile(file.path)}
        >
          <span className={styles.fileListName}>{file.path}</span>
          <span className={styles.fileStats}>
            {file.added > 0 && <span className={styles.statAdded}>+{file.added}</span>}
            {file.removed > 0 && <span className={styles.statRemoved}>-{file.removed}</span>}
          </span>
        </div>
      ))}
    </div>
  );
}
