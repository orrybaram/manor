import { useState, useRef, useCallback, useEffect } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import * as Dialog from "@radix-ui/react-dialog";
import ExternalLink from "lucide-react/dist/esm/icons/external-link";
import Plus from "lucide-react/dist/esm/icons/plus";
import Minus from "lucide-react/dist/esm/icons/minus";
import Archive from "lucide-react/dist/esm/icons/archive";
import Trash2 from "lucide-react/dist/esm/icons/trash-2";
import type { DiffFile, DiffMode } from "../types";
import { Checkbox } from "../../../ui/Checkbox/Checkbox";
import { Button } from "../../../ui/Button/Button";
import styles from "./FileList.module.css";

type FileListProps = {
  files: DiffFile[];
  onSelectFile: (path: string) => void;
  animationState: Map<string, "new" | "updated">;
  diffMode: DiffMode;
  workspacePath?: string;
  selectedFiles: Set<string>;
  onSelectionChange: (selected: Set<string>) => void;
};

type ConfirmAction = {
  type: "discard" | "stash";
  files: string[];
} | null;

export function FileList({
  files,
  onSelectFile,
  animationState,
  diffMode,
  workspacePath,
  selectedFiles,
  onSelectionChange,
}: FileListProps) {
  const totalAdded = files.reduce((s, f) => s + f.added, 0);
  const totalRemoved = files.reduce((s, f) => s + f.removed, 0);
  const lastClickedIndex = useRef<number>(0);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null);
  const isLocal = diffMode === "local";

  // Escape clears selection
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onSelectionChange(new Set());
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onSelectionChange]);

  const handleRowClick = useCallback(
    (e: React.MouseEvent, file: DiffFile, index: number) => {
      if (e.shiftKey) {
        // Range toggle — matches the state of the target file
        const start = Math.min(lastClickedIndex.current, index);
        const end = Math.max(lastClickedIndex.current, index);
        const adding = !selectedFiles.has(file.path);
        const next = new Set(selectedFiles);
        for (let i = start; i <= end; i++) {
          if (adding) next.add(files[i].path);
          else next.delete(files[i].path);
        }
        onSelectionChange(next);
      } else {
        // Toggle file in selection
        const next = new Set(selectedFiles);
        if (next.has(file.path)) {
          next.delete(file.path);
        } else {
          next.add(file.path);
        }
        onSelectionChange(next);
        lastClickedIndex.current = index;
      }
    },
    [files, selectedFiles, onSelectionChange],
  );

  const handleFileNameClick = useCallback(
    (e: React.MouseEvent, file: DiffFile) => {
      e.stopPropagation();
      onSelectFile(file.path);
    },
    [onSelectFile],
  );

  const handleContextMenu = useCallback(
    (file: DiffFile) => {
      if (!selectedFiles.has(file.path)) {
        onSelectionChange(new Set([file.path]));
      }
    },
    [selectedFiles, onSelectionChange],
  );

  const handleOpenInEditor = useCallback(() => {
    if (!workspacePath) return;
    for (const path of selectedFiles) {
      window.electronAPI.shell.openInEditor(`${workspacePath}/${path}`);
    }
  }, [workspacePath, selectedFiles]);

  const handleStage = useCallback(() => {
    if (!workspacePath) return;
    window.electronAPI.git.stage(workspacePath, [...selectedFiles]);
  }, [workspacePath, selectedFiles]);

  const handleUnstage = useCallback(() => {
    if (!workspacePath) return;
    window.electronAPI.git.unstage(workspacePath, [...selectedFiles]);
  }, [workspacePath, selectedFiles]);

  const handleConfirmAction = useCallback(() => {
    if (!confirmAction || !workspacePath) return;
    if (confirmAction.type === "discard") {
      window.electronAPI.git.discard(workspacePath, confirmAction.files);
    } else {
      window.electronAPI.git.stash(workspacePath, confirmAction.files);
    }
    setConfirmAction(null);
  }, [confirmAction, workspacePath]);

  return (
    <>
      <div className={styles.fileList}>
        <div className={styles.fileListHeader}>
          {isLocal && (
            <Checkbox
              className={styles.checkbox}
              checked={
                selectedFiles.size === files.length
                  ? true
                  : selectedFiles.size > 0
                    ? "indeterminate"
                    : false
              }
              onCheckedChange={() => {
                if (selectedFiles.size === files.length) {
                  onSelectionChange(new Set());
                } else {
                  onSelectionChange(new Set(files.map((f) => f.path)));
                }
              }}
            />
          )}
          {files.length} {files.length === 1 ? "file" : "files"} changed
          {totalAdded > 0 && (
            <span className={styles.statAdded}> +{totalAdded}</span>
          )}
          {totalRemoved > 0 && (
            <span className={styles.statRemoved}> -{totalRemoved}</span>
          )}
          {selectedFiles.size > 0 && (
            <span className={styles.selectionInfo}>
              {selectedFiles.size} selected
            </span>
          )}
        </div>
        {files.map((file, index) => {
          const lastSlash = file.path.lastIndexOf("/");
          const fileName = lastSlash === -1 ? file.path : file.path.slice(lastSlash + 1);
          const fileDir = lastSlash === -1 ? "" : file.path.slice(0, lastSlash + 1);
          return (
          <ContextMenu.Root key={file.path}>
            <ContextMenu.Trigger asChild>
              <div
                className={[
                  styles.fileListItem,
                  selectedFiles.has(file.path)
                    ? styles.fileListItemSelected
                    : undefined,
                  animationState.get(file.path) === "new"
                    ? styles.fileListItemNew
                    : undefined,
                  animationState.get(file.path) === "updated"
                    ? styles.fileListItemUpdated
                    : undefined,
                ]
                  .filter(Boolean)
                  .join(" ")}
                onClick={(e) => handleRowClick(e, file, index)}
                onContextMenu={() => handleContextMenu(file)}
              >
                {isLocal && (
                  <Checkbox
                    className={styles.checkbox}
                    checked={selectedFiles.has(file.path)}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleRowClick(e, file, index);
                    }}
                  />
                )}
                <span
                  className={styles.fileListName}
                  onClick={(e) => handleFileNameClick(e, file)}
                >
                  <span className={styles.fileName}>{fileName}</span>
                  {fileDir && <span className={styles.fileDir}>{fileDir}</span>}
                </span>
                <span className={styles.fileStats}>
                  {file.added > 0 && (
                    <span className={styles.statAdded}>+{file.added}</span>
                  )}
                  {file.removed > 0 && (
                    <span className={styles.statRemoved}>-{file.removed}</span>
                  )}
                </span>
              </div>
            </ContextMenu.Trigger>
            <ContextMenu.Portal>
              <ContextMenu.Content className={styles.contextMenu}>
                <ContextMenu.Item
                  className={styles.contextMenuItem}
                  onSelect={handleOpenInEditor}
                >
                  <ExternalLink size={14} />
                  Open in Editor
                </ContextMenu.Item>
                {isLocal && workspacePath && (
                  <>
                    <ContextMenu.Separator
                      className={styles.contextMenuSeparator}
                    />
                    <ContextMenu.Item
                      className={styles.contextMenuItem}
                      onSelect={handleStage}
                    >
                      <Plus size={14} />
                      Stage
                    </ContextMenu.Item>
                    <ContextMenu.Item
                      className={styles.contextMenuItem}
                      onSelect={handleUnstage}
                    >
                      <Minus size={14} />
                      Unstage
                    </ContextMenu.Item>
                    <ContextMenu.Item
                      className={styles.contextMenuItem}
                      onSelect={() =>
                        setConfirmAction({
                          type: "stash",
                          files: [...selectedFiles],
                        })
                      }
                    >
                      <Archive size={14} />
                      Stash
                    </ContextMenu.Item>
                    <ContextMenu.Separator
                      className={styles.contextMenuSeparator}
                    />
                    <ContextMenu.Item
                      className={[
                        styles.contextMenuItem,
                        styles.contextMenuItemDestructive,
                      ].join(" ")}
                      onSelect={() =>
                        setConfirmAction({
                          type: "discard",
                          files: [...selectedFiles],
                        })
                      }
                    >
                      <Trash2 size={14} />
                      Discard
                    </ContextMenu.Item>
                  </>
                )}
              </ContextMenu.Content>
            </ContextMenu.Portal>
          </ContextMenu.Root>
        )})}
      </div>

      <Dialog.Root
        open={confirmAction !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmAction(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className={styles.confirmOverlay} />
          <Dialog.Content className={styles.confirmDialog}>
            <Dialog.Title className={styles.confirmTitle}>
              {confirmAction?.type === "discard"
                ? "Discard Changes"
                : "Stash Files"}
            </Dialog.Title>
            <Dialog.Description className={styles.confirmDescription}>
              {confirmAction?.type === "discard"
                ? "This will permanently discard changes to the following files:"
                : "The following files will be stashed:"}
            </Dialog.Description>
            <ul className={styles.confirmFileList}>
              {confirmAction?.files.map((f) => (
                <li key={f}>
                  <code>{f}</code>
                </li>
              ))}
            </ul>
            <div className={styles.confirmActions}>
              <Button
                variant="secondary"
                onClick={() => setConfirmAction(null)}
              >
                Cancel
              </Button>
              <Button variant="danger" onClick={handleConfirmAction}>
                {confirmAction?.type === "discard" ? "Discard" : "Stash"}
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
