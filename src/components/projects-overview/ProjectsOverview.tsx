import { useCallback, useState, type DragEvent } from "react";
import FolderOpen from "lucide-react/dist/esm/icons/folder-open";
import Server from "lucide-react/dist/esm/icons/server";
import { ManorLogo } from "../ui/ManorLogo";
import { Button } from "../ui/Button/Button";
import { Stack } from "../ui/Layout/Layout";
import styles from "./ProjectsOverview.module.css";

export interface ProjectsOverviewProps {
  /** "Open a folder": the directory picker, straight away. */
  onAddLocal: () => void;
  /** "Clone onto a remote host": `AddProjectDialog` in remote mode. */
  onAddRemote: () => void;
  /** A folder dropped on the drop zone. */
  onDropFolder: (folderPath: string) => void;
}

/**
 * The Projects overview (ADR-194 §2): an app-level surface shown from the
 * sidebar's Projects row, over whatever workspace is active. This is the
 * skeleton — heading plus the "Add a project" actions; the project cards
 * come with ticket 3.
 */
export function ProjectsOverview(props: ProjectsOverviewProps) {
  const { onAddLocal, onAddRemote, onDropFolder } = props;

  const [dragging, setDragging] = useState(false);

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(false);
  }, []);

  const handleDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragging(false);
      const folder = Array.from(e.dataTransfer.files).find(
        (f) => f.type === "" && f.size === 0,
      );
      // Electron exposes the real path on the File object.
      const folderPath = (folder as (File & { path?: string }) | undefined)
        ?.path;
      if (folderPath) onDropFolder(folderPath);
    },
    [onDropFolder],
  );

  return (
    <div className={styles.container} data-testid="projects-overview">
      <Stack gap="3xl" className={styles.content}>
        <div className={styles.logo}>
          <ManorLogo />
        </div>
        <h1 className={styles.heading}>Projects</h1>
        <Stack gap="xs">
          <div className={styles.sectionLabel}>Add a project</div>
          <Button variant="ghost" className={styles.action} onClick={onAddLocal}>
            <FolderOpen size={14} />
            Open a folder
          </Button>
          <Button variant="ghost" className={styles.action} onClick={onAddRemote}>
            <Server size={14} />
            Clone onto a remote host
          </Button>
          <div
            className={`${styles.dropZone} ${dragging ? styles.dragging : ""}`}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            Drop a folder here
          </div>
        </Stack>
      </Stack>
    </div>
  );
}
