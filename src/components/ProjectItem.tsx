import React, {
  useEffect,
  useCallback,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import * as Dialog from "@radix-ui/react-dialog";
import {
  Plus,
  ChevronDown,
  ChevronRight,
  House,
  FolderGit2,
  GitBranch,
  GitPullRequest,
  GitMerge,
  GitPullRequestClosed,
} from "lucide-react";
import type { ProjectInfo, WorkspaceInfo } from "../store/project-store";
import { NewWorkspaceDialog } from "./NewWorkspaceDialog";
import styles from "./Sidebar.module.css";

const EMPTY_STYLE: React.CSSProperties = {};

export const ProjectItem = React.memo(function ProjectItem({
  project,
  isSelected,
  collapsed,
  onToggleCollapsed,
  onSelect: _onSelect,
  onRemove,
  onSelectWorkspace,
  onRemoveWorktree,
  onRenameWorkspace,
  onReorderWorkspaces,
  onCreateWorktree,
  onDragStart,
}: {
  project: ProjectInfo;
  isSelected: boolean;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onSelect: () => void;
  onRemove: () => void;
  onSelectWorkspace: (index: number) => void;
  onRemoveWorktree: (ws: WorkspaceInfo, deleteBranch: boolean) => void;
  onRenameWorkspace: (ws: WorkspaceInfo, newName: string) => void;
  onReorderWorkspaces: (orderedPaths: string[]) => void;
  onCreateWorktree: (name: string, branch: string) => Promise<string | null>;
  onDragStart?: (e: ReactPointerEvent) => void;
}) {
  const expanded = !collapsed;
  const [editingPath, setEditingPath] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [confirmDeleteWorktree, setConfirmDeleteWorktree] =
    useState<WorkspaceInfo | null>(null);
  const [deleteBranchChecked, setDeleteBranchChecked] = useState(
    () => localStorage.getItem("manor:deleteBranchOnWorktreeRemove") === "true",
  );
  const [newWorkspaceOpen, setNewWorkspaceOpen] = useState(false);
  const [deletingPaths, setDeletingPaths] = useState<Set<string>>(new Set());
  const editRef = useRef<HTMLInputElement>(null);

  // Drag-and-drop state
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [dragOffset, setDragOffset] = useState(0);
  const dropIndexRef = useRef<number | null>(null);
  const dragStartY = useRef(0);
  const dragActive = useRef(false);
  const dragCleanedUp = useRef(false);
  const justDragged = useRef(false);
  const itemRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const itemHeights = useRef<number[]>([]);

  const startRename = useCallback((ws: WorkspaceInfo) => {
    setEditingPath(ws.path);
    setEditValue(ws.name || ws.branch || "");
  }, []);

  const commitRename = useCallback(
    (ws: WorkspaceInfo) => {
      setEditingPath(null);
      onRenameWorkspace(ws, editValue);
    },
    [editValue, onRenameWorkspace],
  );

  useEffect(() => {
    if (editingPath && editRef.current) {
      editRef.current.focus();
      editRef.current.select();
    }
  }, [editingPath]);

  const handleDragStart = useCallback(
    (idx: number, e: ReactPointerEvent) => {
      if (editingPath) return;
      // Only handle left mouse button
      if (e.button !== 0) return;

      const target = e.currentTarget as HTMLElement;
      dragStartY.current = e.clientY;
      dragActive.current = false;
      dragCleanedUp.current = false;

      // Snapshot item heights (gap matches .workspaces CSS gap)
      const WORKSPACE_GAP = 8;
      const heights: number[] = [];
      for (let i = 0; i < project.workspaces.length; i++) {
        const el = itemRefs.current.get(i);
        heights[i] = el
          ? el.getBoundingClientRect().height + WORKSPACE_GAP
          : 36;
      }
      itemHeights.current = heights;

      // Use pointer capture so we get events even outside the element
      target.setPointerCapture(e.pointerId);

      const onMove = (ev: globalThis.PointerEvent) => {
        const dy = ev.clientY - dragStartY.current;
        if (!dragActive.current && Math.abs(dy) < 4) return;

        if (!dragActive.current) {
          dragActive.current = true;
          setDragIndex(idx);
          setDropIndex(idx);
        }

        setDragOffset(dy);

        // Calculate which index we're over
        let offset = 0;
        let targetIdx = idx;
        if (dy < 0) {
          for (let i = idx - 1; i >= 0; i--) {
            offset -= itemHeights.current[i];
            if (dy < offset + itemHeights.current[i] / 2) {
              targetIdx = i;
            } else break;
          }
        } else {
          for (let i = idx + 1; i < project.workspaces.length; i++) {
            offset += itemHeights.current[i];
            if (dy > offset - itemHeights.current[i] / 2) {
              targetIdx = i;
            } else break;
          }
        }
        if (dropIndexRef.current !== targetIdx) {
          dropIndexRef.current = targetIdx;
          setDropIndex(targetIdx);
        }
      };

      const onUp = () => {
        // Guard against double-fire (pointerup + lostpointercapture)
        if (dragCleanedUp.current) return;
        dragCleanedUp.current = true;

        target.removeEventListener("pointermove", onMove);
        target.removeEventListener("pointerup", onUp);
        target.removeEventListener("lostpointercapture", onUp);

        if (dragActive.current) {
          justDragged.current = true;
          const finalDrop = dropIndexRef.current ?? idx;
          if (finalDrop !== idx) {
            const paths = project.workspaces.map((ws) => ws.path);
            const [moved] = paths.splice(idx, 1);
            paths.splice(finalDrop, 0, moved);
            onReorderWorkspaces(paths);
          }
          requestAnimationFrame(() => {
            justDragged.current = false;
          });
        }
        dragActive.current = false;
        dropIndexRef.current = null;
        setDragIndex(null);
        setDropIndex(null);
        setDragOffset(0);
      };

      target.addEventListener("pointermove", onMove);
      target.addEventListener("pointerup", onUp);
      target.addEventListener("lostpointercapture", onUp);
    },
    [editingPath, project.workspaces, onReorderWorkspaces],
  );

  // Compute transform offsets for smooth animation
  const getTransformStyle = (idx: number): React.CSSProperties => {
    if (dragIndex === null || dropIndex === null) return EMPTY_STYLE;
    const h = itemHeights.current[dragIndex] || 36;
    if (idx === dragIndex) {
      return {
        transform: `translateY(${dragOffset}px)`,
        zIndex: 10,
      };
    }
    if (dragIndex === dropIndex) return { transition: "transform 150ms ease" };
    if (
      (dropIndex > dragIndex && idx > dragIndex && idx <= dropIndex) ||
      (dropIndex < dragIndex && idx < dragIndex && idx >= dropIndex)
    ) {
      const direction = dropIndex > dragIndex ? -1 : 1;
      return {
        transform: `translateY(${direction * h}px)`,
        transition: "transform 150ms ease",
      };
    }
    return { transition: "transform 150ms ease" };
  };

  return (
    <div className={styles.project}>
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>
          <div
            className={styles.projectHeader}
            onClick={() => {
              onToggleCollapsed();
            }}
            onPointerDown={onDragStart}
            style={{ touchAction: "none" }}
          >
            <span className={styles.projectChevron}>
              {expanded ? (
                <ChevronDown size={12} />
              ) : (
                <ChevronRight size={12} />
              )}
            </span>
            <span className={styles.projectName} title={project.path}>
              {project.name}
            </span>
            <button
              className={styles.projectAction}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                setNewWorkspaceOpen(true);
              }}
              title="New Workspace"
            >
              <Plus size={12} />
            </button>
          </div>
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content className={styles.contextMenu}>
            <ContextMenu.Item
              className={styles.contextMenuItem}
              onSelect={() => setNewWorkspaceOpen(true)}
            >
              New Workspace
            </ContextMenu.Item>
            <ContextMenu.Item
              className={`${styles.contextMenuItem} ${styles.contextMenuItemDanger}`}
              onSelect={() => setConfirmRemove(true)}
            >
              Remove Project
            </ContextMenu.Item>
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>
      {expanded && (
        <div className={styles.workspaces}>
          {project.workspaces.map((ws, idx) => {
            const isEditing = editingPath === ws.path;
            const displayName = ws.isMain
              ? ws.name || "local"
              : ws.name || ws.branch || "main";
            const isDragging = dragIndex === idx;
            const isDeleting = deletingPaths.has(ws.path);

            const workspaceEl = (
              <div
                key={ws.path}
                ref={(el) => {
                  if (el) itemRefs.current.set(idx, el);
                  else itemRefs.current.delete(idx);
                }}
                className={`${styles.workspace} ${
                  isSelected && idx === project.selectedWorkspaceIndex
                    ? styles.workspaceActive
                    : ""
                } ${isDragging ? styles.workspaceDragging : ""} ${isDeleting ? styles.workspaceDeleting : ""}`}
                style={getTransformStyle(idx)}
                onClick={() => {
                  if (!justDragged.current) onSelectWorkspace(idx);
                }}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  startRename(ws);
                }}
                onPointerDown={(e) => handleDragStart(idx, e)}
              >
                {isEditing ? (
                  <input
                    ref={editRef}
                    className={styles.workspaceNameInput}
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onBlur={() => {
                      if (editingPath) commitRename(ws);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitRename(ws);
                      if (e.key === "Escape") {
                        setEditingPath(null);
                        e.currentTarget.blur();
                      }
                    }}
                    onClick={(e) => e.stopPropagation()}
                    onPointerDown={(e) => e.stopPropagation()}
                  />
                ) : (
                  <>
                    <span className={styles.workspaceIcon}>
                      {ws.isMain ? (
                        <House size={12} />
                      ) : (
                        <FolderGit2 size={12} />
                      )}
                    </span>
                    <div className={styles.workspaceLabel}>
                      <div className={styles.workspaceNameRow}>
                        <span className={styles.workspaceName}>
                          {displayName}
                        </span>
                        {ws.diffStats && (ws.diffStats.added > 0 || ws.diffStats.removed > 0) && (
                          <span className={styles.diffStats}>
                            {ws.diffStats.added > 0 && (
                              <span className={styles.diffAdded}>+{ws.diffStats.added}</span>
                            )}
                            {ws.diffStats.removed > 0 && (
                              <span className={styles.diffRemoved}>-{ws.diffStats.removed}</span>
                            )}
                          </span>
                        )}
                      </div>
                      <div className={styles.workspaceBranchRow}>
                        <span className={styles.workspaceBranch}>
                          {ws.branch || "main"}
                        </span>
                        {ws.pr && (
                          <span
                            className={`${styles.prBadge} ${
                              ws.pr.state === "merged"
                                ? styles.prMerged
                                : ws.pr.state === "closed"
                                  ? styles.prClosed
                                  : styles.prOpen
                            }`}
                            title={ws.pr.title}
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={(e) => {
                              e.stopPropagation();
                              window.electronAPI.openExternal(ws.pr!.url);
                            }}
                          >
                            {ws.pr.state === "merged" ? (
                              <GitMerge size={10} />
                            ) : ws.pr.state === "closed" ? (
                              <GitPullRequestClosed size={10} />
                            ) : (
                              <GitPullRequest size={10} />
                            )}
                            #{ws.pr.number}
                          </span>
                        )}
                      </div>
                    </div>
                  </>
                )}
              </div>
            );

            return (
              <ContextMenu.Root key={ws.path}>
                <ContextMenu.Trigger asChild>{workspaceEl}</ContextMenu.Trigger>
                <ContextMenu.Portal>
                  <ContextMenu.Content className={styles.contextMenu}>
                    <ContextMenu.Item
                      className={styles.contextMenuItem}
                      onSelect={() =>
                        window.electronAPI.openExternal(`file://${ws.path}`)
                      }
                    >
                      Open in Finder
                    </ContextMenu.Item>
                    <ContextMenu.Item
                      className={styles.contextMenuItem}
                      onSelect={() =>
                        navigator.clipboard.writeText(ws.branch || "main")
                      }
                    >
                      Copy Branch Name
                    </ContextMenu.Item>
                    <ContextMenu.Item
                      className={styles.contextMenuItem}
                      onSelect={() => navigator.clipboard.writeText(ws.path)}
                    >
                      Copy Path
                    </ContextMenu.Item>
                    {!ws.isMain && (
                      <>
                        <ContextMenu.Separator
                          className={styles.contextMenuSeparator}
                        />
                        <ContextMenu.Item
                          className={styles.contextMenuItem}
                          onSelect={() => startRename(ws)}
                        >
                          Rename Workspace
                        </ContextMenu.Item>
                        <ContextMenu.Item
                          className={`${styles.contextMenuItem} ${styles.contextMenuItemDanger}`}
                          onSelect={() => {
                            setConfirmDeleteWorktree(ws);
                          }}
                        >
                          Delete Workspace
                        </ContextMenu.Item>
                      </>
                    )}
                  </ContextMenu.Content>
                </ContextMenu.Portal>
              </ContextMenu.Root>
            );
          })}
        </div>
      )}

      <NewWorkspaceDialog
        open={newWorkspaceOpen}
        onClose={() => setNewWorkspaceOpen(false)}
        projects={[project]}
        selectedProjectIndex={0}
        onSubmit={async (_projectId, name, branch) => {
          const result = await onCreateWorktree(name, branch);
          if (result) {
            setNewWorkspaceOpen(false);
          }
          return !!result;
        }}
      />

      <Dialog.Root open={confirmRemove} onOpenChange={setConfirmRemove}>
        <Dialog.Portal>
          <Dialog.Overlay className={styles.confirmOverlay} />
          <Dialog.Content className={styles.confirmDialog}>
            <Dialog.Title className={styles.confirmTitle}>
              Remove Project
            </Dialog.Title>
            <Dialog.Description className={styles.confirmDescription}>
              Remove <strong>{project.name}</strong> from the sidebar? This
              won't delete any files on disk.
            </Dialog.Description>
            <div className={styles.confirmActions}>
              <button
                className={styles.confirmCancel}
                onClick={() => setConfirmRemove(false)}
              >
                Cancel
              </button>
              <button
                className={styles.confirmRemove}
                onClick={() => {
                  setConfirmRemove(false);
                  onRemove();
                }}
              >
                Remove
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root
        open={confirmDeleteWorktree !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmDeleteWorktree(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className={styles.confirmOverlay} />
          <Dialog.Content className={styles.confirmDialog}>
            <Dialog.Title className={styles.confirmTitle}>
              Delete Workspace
            </Dialog.Title>
            <Dialog.Description className={styles.confirmDescription}>
              Delete workspace{" "}
              <strong>
                {confirmDeleteWorktree?.name ||
                  confirmDeleteWorktree?.branch ||
                  ""}
              </strong>
              ? This will remove the worktree from disk.
            </Dialog.Description>
            {confirmDeleteWorktree?.branch && (
              <div className={styles.branchDeleteSection}>
                <code className={styles.branchName}>
                  <GitBranch size={12} />
                  {confirmDeleteWorktree.branch}
                </code>
                <label className={styles.checkboxLabel}>
                  <input
                    type="checkbox"
                    checked={deleteBranchChecked}
                    onChange={(e) => {
                      setDeleteBranchChecked(e.target.checked);
                      localStorage.setItem(
                        "manor:deleteBranchOnWorktreeRemove",
                        String(e.target.checked),
                      );
                    }}
                  />
                  Also delete local branch
                </label>
              </div>
            )}
            <div className={styles.confirmActions}>
              <button
                className={styles.confirmCancel}
                onClick={() => setConfirmDeleteWorktree(null)}
              >
                Cancel
              </button>
              <button
                className={styles.confirmRemove}
                onClick={() => {
                  const ws = confirmDeleteWorktree;
                  setConfirmDeleteWorktree(null);
                  if (ws) {
                    setDeletingPaths((prev) => new Set(prev).add(ws.path));
                    onRemoveWorktree(ws, deleteBranchChecked);
                  }
                }}
              >
                Delete
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
});
