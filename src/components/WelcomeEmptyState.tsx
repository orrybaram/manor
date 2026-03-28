import { useState, useCallback } from "react";
import FolderOpen from "lucide-react/dist/esm/icons/folder-open";
import { ManorLogo } from "./ui/ManorLogo";
import styles from "./WelcomeEmptyState.module.css";

interface WelcomeEmptyStateProps {
  onAddProject: () => void;
  onDropFolder?: (folderPath: string) => void;
}

/** Shown when there are no projects at all. */
export function WelcomeEmptyState(props: WelcomeEmptyStateProps) {
  const { onAddProject, onDropFolder } = props;

  const [dragging, setDragging] = useState(false);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragging(false);

      const files = Array.from(e.dataTransfer.files);
      const folder = files.find((f) => f.type === "" && f.size === 0);
      if (folder) {
        // Electron exposes the real path on the File object
        const folderPath = (folder as File & { path?: string }).path;
        if (folderPath && onDropFolder) {
          onDropFolder(folderPath);
          return;
        }
      }
      // Fallback: open the native dialog
      onAddProject();
    },
    [onAddProject, onDropFolder],
  );

  return (
    <div className={styles.container}>
      <div className={styles.logo}>
        <ManorLogo />
      </div>
      <div
        className={`${styles.dropZone} ${dragging ? styles.dragging : ""}`}
        onClick={onAddProject}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <div className={styles.title}>
          <FolderOpen size={20} />
          Open Project
        </div>
        <div className={styles.subtitle}>
          Click to browse
        </div>
      </div>
    </div>
  );
}
