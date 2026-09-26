import { useState, useCallback } from "react";
import FolderOpen from "lucide-react/dist/esm/icons/folder-open";
import { ManorLogo } from "../../ui/ManorLogo";
import { Stack, Row } from "../../ui/Layout/Layout";
import { isWebApp } from "../../../lib/platform";
import styles from "./WelcomeEmptyState.module.css";

interface WelcomeEmptyStateProps {
  onAddProject: () => void;
  onDropFolder?: (folderPath: string) => void;
}

/** Shown when there are no projects at all. */
export function WelcomeEmptyState(props: WelcomeEmptyStateProps) {
  const { onAddProject, onDropFolder } = props;

  const [dragging, setDragging] = useState(false);

  // No filesystem picker and no `File.path` in a browser tab (ADR-178): the
  // button below would open nothing, and drag-drop would silently fail to
  // resolve a real path. Removed rather than disabled, with one line saying
  // where projects come from instead.
  const webApp = isWebApp();

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

  if (webApp) {
    return (
      <Stack align="center" justify="center" gap="2xl" className={styles.container}>
        <div className={styles.logo}>
          <ManorLogo />
        </div>
        <div className={styles.subtitle}>
          Projects are added from the desktop app.
        </div>
      </Stack>
    );
  }

  return (
    <Stack align="center" justify="center" gap="2xl" className={styles.container}>
      <div className={styles.logo}>
        <ManorLogo />
      </div>
      <div
        className={`${styles.dropZone} ${dragging ? styles.dragging : ""}`}
        role="button"
        tabIndex={0}
        aria-label="Open project"
        onClick={onAddProject}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onAddProject();
          }
        }}
        data-testid="import-project-button"
      >
        <Row align="center" gap="sm" className={styles.title}>
          <FolderOpen size={20} />
          Open Project
        </Row>
        <div className={styles.subtitle}>
          Click to browse
        </div>
      </div>
    </Stack>
  );
}
