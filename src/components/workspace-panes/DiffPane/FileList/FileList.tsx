import { useState, useRef, useCallback, useEffect } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import * as Dialog from "@radix-ui/react-dialog";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import Circle from "lucide-react/dist/esm/icons/circle";
import ExternalLink from "lucide-react/dist/esm/icons/external-link";
import Plus from "lucide-react/dist/esm/icons/plus";
import Minus from "lucide-react/dist/esm/icons/minus";
import Trash2 from "lucide-react/dist/esm/icons/trash-2";
import type { DiffFile, DiffMode } from "../types";
import { Button } from "../../../ui/Button/Button";
import { Tooltip } from "../../../ui/Tooltip/Tooltip";
import { AnimatedCount } from "../../../ui/AnimatedCount/AnimatedCount";
import { useToastStore } from "../../../../store/toast-store";
import styles from "./FileList.module.css";
import { Row } from "../../../ui/Layout/Layout";

type FileListProps = {
  files: DiffFile[];
  onSelectFile: (path: string) => void;
  animationState: Map<string, "new" | "updated">;
  diffMode: DiffMode;
  workspacePath?: string;
  selectedFiles: Set<string>;
  onSelectionChange: (selected: Set<string>) => void;
  stagedFiles: Set<string>;
  onStagedFilesChange: (updater: (prev: Set<string>) => Set<string>) => void;
};

type ConfirmAction = {
  type: "discard";
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
  stagedFiles,
  onStagedFilesChange,
}: FileListProps) {
  const totalAdded = files.reduce((s, f) => s + f.added, 0);
  const totalRemoved = files.reduce((s, f) => s + f.removed, 0);
  const lastClickedIndex = useRef<number>(0);
  const [collapsed, setCollapsed] = useState(false);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null);
  const [actionInProgress, setActionInProgress] = useState(false);
  const isLocal = diffMode === "local";
  const addToast = useToastStore((s) => s.addToast);

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
        e.preventDefault();
        const start = Math.min(lastClickedIndex.current, index);
        const end = Math.max(lastClickedIndex.current, index);
        const next = new Set(selectedFiles);
        for (let i = start; i <= end; i++) {
          next.add(files[i].path);
        }
        onSelectionChange(next);
      } else if (e.metaKey || e.ctrlKey) {
        const next = new Set(selectedFiles);
        if (next.has(file.path)) {
          next.delete(file.path);
        } else {
          next.add(file.path);
        }
        onSelectionChange(next);
        lastClickedIndex.current = index;
      } else {
        onSelectionChange(new Set([file.path]));
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

  const getActionFiles = useCallback(
    (filePath: string) => {
      if (selectedFiles.has(filePath)) {
        return [...selectedFiles];
      }
      return [filePath];
    },
    [selectedFiles],
  );

  const fileLabel = (count: number) =>
    count === 1 ? "1 file" : `${count} files`;

  const handleStage = useCallback(
    async (filePath: string) => {
      if (!workspacePath || actionInProgress) return;
      const targetFiles = getActionFiles(filePath);
      const toastId = `stage-${Date.now()}`;

      // Optimistic update
      onStagedFilesChange((prev) => {
        const next = new Set(prev);
        for (const f of targetFiles) next.add(f);
        return next;
      });

      setActionInProgress(true);
      try {
        await window.electronAPI.git.stage(workspacePath, targetFiles);
        addToast({
          id: toastId,
          message: `Staged ${fileLabel(targetFiles.length)}`,
          status: "success",
        });
      } catch {
        // Revert optimistic update
        onStagedFilesChange((prev) => {
          const next = new Set(prev);
          for (const f of targetFiles) next.delete(f);
          return next;
        });
        addToast({
          id: toastId,
          message: "Failed to stage files",
          status: "error",
        });
      } finally {
        setActionInProgress(false);
      }
    },
    [
      workspacePath,
      actionInProgress,
      getActionFiles,
      onStagedFilesChange,
      addToast,
    ],
  );

  const handleUnstage = useCallback(
    async (filePath: string) => {
      if (!workspacePath || actionInProgress) return;
      const targetFiles = getActionFiles(filePath);
      const toastId = `unstage-${Date.now()}`;

      // Optimistic update
      onStagedFilesChange((prev) => {
        const next = new Set(prev);
        for (const f of targetFiles) next.delete(f);
        return next;
      });

      setActionInProgress(true);
      try {
        await window.electronAPI.git.unstage(workspacePath, targetFiles);
        addToast({
          id: toastId,
          message: `Unstaged ${fileLabel(targetFiles.length)}`,
          status: "success",
        });
      } catch {
        // Revert optimistic update
        onStagedFilesChange((prev) => {
          const next = new Set(prev);
          for (const f of targetFiles) next.add(f);
          return next;
        });
        addToast({
          id: toastId,
          message: "Failed to unstage files",
          status: "error",
        });
      } finally {
        setActionInProgress(false);
      }
    },
    [
      workspacePath,
      actionInProgress,
      getActionFiles,
      onStagedFilesChange,
      addToast,
    ],
  );

  // Space toggles stage/unstage on selection
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        e.key !== " " ||
        !isLocal ||
        !workspacePath ||
        selectedFiles.size === 0 ||
        actionInProgress
      )
        return;
      const target = e.target as HTMLElement;
      if (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable
      )
        return;
      e.preventDefault();
      const selected = [...selectedFiles];
      const allStaged = selected.every((f) => stagedFiles.has(f));
      if (allStaged) {
        handleUnstage(selected[0]);
      } else {
        handleStage(selected[0]);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    isLocal,
    workspacePath,
    selectedFiles,
    stagedFiles,
    actionInProgress,
    handleStage,
    handleUnstage,
  ]);

  const handleDiscard = useCallback(
    (filePath: string) => {
      if (actionInProgress) return;
      setConfirmAction({ type: "discard", files: getActionFiles(filePath) });
    },
    [actionInProgress, getActionFiles],
  );

  const handleConfirmAction = useCallback(async () => {
    if (!confirmAction || !workspacePath) return;
    const targetFiles = confirmAction.files;
    const toastId = `discard-${Date.now()}`;

    setConfirmAction(null);
    setActionInProgress(true);
    try {
      await window.electronAPI.git.discard(workspacePath, targetFiles);
      addToast({
        id: toastId,
        message: `Discarded changes in ${fileLabel(targetFiles.length)}`,
        status: "success",
      });
    } catch {
      addToast({
        id: toastId,
        message: "Failed to discard changes",
        status: "error",
      });
    } finally {
      setActionInProgress(false);
    }
  }, [confirmAction, workspacePath, addToast]);

  return (
    <>
      <div className={styles.fileList}>
        <button
          className={styles.fileListHeader}
          onClick={() => setCollapsed((c) => !c)}
        >
          <ChevronRight
            size={14}
            className={[
              styles.collapseIcon,
              collapsed ? undefined : styles.collapseIconOpen,
            ]
              .filter(Boolean)
              .join(" ")}
          />
          {files.length} {files.length === 1 ? "file" : "files"} changed
          <span className={styles.fileStats}>
            {totalAdded > 0 && (
              <AnimatedCount
                value={totalAdded}
                prefix="+"
                className={styles.statAdded}
              />
            )}
            {totalRemoved > 0 && (
              <AnimatedCount
                value={totalRemoved}
                prefix="-"
                className={styles.statRemoved}
              />
            )}
          </span>
        </button>
        {!collapsed &&
          files.map((file, index) => {
            const lastSlash = file.path.lastIndexOf("/");
            const fileName =
              lastSlash === -1 ? file.path : file.path.slice(lastSlash + 1);
            const fileDir =
              lastSlash === -1 ? "" : file.path.slice(0, lastSlash + 1);
            const isStaged = stagedFiles.has(file.path);
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
                    <span className={styles.fileListName}>
                      <Row gap="sm" align="center">
                        {isLocal && (
                          <Circle
                            size={6}
                            className={
                              isStaged ? styles.stagedIcon : styles.unstagedIcon
                            }
                          />
                        )}

                        <span
                          onClick={(e) => handleFileNameClick(e, file)}
                          className={styles.fileName}
                        >
                          {fileName}
                        </span>
                      </Row>
                      {fileDir && (
                        <span className={styles.fileDir}>{fileDir}</span>
                      )}
                    </span>
                    {isLocal && workspacePath && (
                      <span className={styles.fileActions}>
                        {isStaged ? (
                          <Tooltip label="Unstage">
                            <button
                              className={styles.actionButton}
                              disabled={actionInProgress}
                              onClick={(e) => {
                                e.stopPropagation();
                                handleUnstage(file.path);
                              }}
                            >
                              <Minus size={14} />
                            </button>
                          </Tooltip>
                        ) : (
                          <>
                            <Tooltip label="Stage">
                              <button
                                className={styles.actionButton}
                                disabled={actionInProgress}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleStage(file.path);
                                }}
                              >
                                <Plus size={14} />
                              </button>
                            </Tooltip>
                            <Tooltip label="Discard">
                              <button
                                className={[
                                  styles.actionButton,
                                  styles.actionButtonDestructive,
                                ].join(" ")}
                                disabled={actionInProgress}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleDiscard(file.path);
                                }}
                              >
                                <Trash2 size={14} />
                              </button>
                            </Tooltip>
                          </>
                        )}
                      </span>
                    )}
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
                        {isStaged ? (
                          <ContextMenu.Item
                            className={styles.contextMenuItem}
                            disabled={actionInProgress}
                            onSelect={() => handleUnstage(file.path)}
                          >
                            <Minus size={14} />
                            Unstage
                          </ContextMenu.Item>
                        ) : (
                          <>
                            <ContextMenu.Item
                              className={styles.contextMenuItem}
                              disabled={actionInProgress}
                              onSelect={() => handleStage(file.path)}
                            >
                              <Plus size={14} />
                              Stage
                            </ContextMenu.Item>
                            <ContextMenu.Separator
                              className={styles.contextMenuSeparator}
                            />
                            <ContextMenu.Item
                              className={[
                                styles.contextMenuItem,
                                styles.contextMenuItemDestructive,
                              ].join(" ")}
                              disabled={actionInProgress}
                              onSelect={() => handleDiscard(file.path)}
                            >
                              <Trash2 size={14} />
                              Discard
                            </ContextMenu.Item>
                          </>
                        )}
                      </>
                    )}
                  </ContextMenu.Content>
                </ContextMenu.Portal>
              </ContextMenu.Root>
            );
          })}
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
              Discard Changes
            </Dialog.Title>
            <Dialog.Description className={styles.confirmDescription}>
              This will permanently discard changes to the following files:
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
                Discard
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
