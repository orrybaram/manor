import React, {
  useCallback,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { Plus, ChevronRight, House, FolderGit2, Settings } from "lucide-react";
import {
  useProjectStore,
  type ProjectInfo,
  type WorkspaceInfo,
} from "../store/project-store";
import { useProjectAgentStatus } from "../hooks/useProjectAgentStatus";
import { useWorkspaceAgentStatus } from "../hooks/useWorkspaceAgentStatus";
import { AgentDot } from "./AgentDot";
import { NewWorkspaceDialog } from "./NewWorkspaceDialog";
import { PrPopover } from "./PrPopover";
import { RemoveProjectDialog } from "./RemoveProjectDialog";
import { DeleteWorktreeDialog } from "./DeleteWorktreeDialog";
import { useWorkspaceDrag } from "../hooks/useWorkspaceDrag";
import styles from "./Sidebar.module.css";

interface WorkspaceItemProps {
  ws: WorkspaceInfo;
  idx: number;
  isSelected: boolean;
  selectedWorkspaceIndex: number;
  isDragging: boolean;
  isDeleting: boolean;
  isEditing: boolean;
  editValue: string;
  editRef: React.RefObject<HTMLInputElement | null>;
  displayName: string;
  getTransformStyle: (idx: number) => React.CSSProperties | undefined;
  justDragged: React.RefObject<boolean>;
  itemRefCallback: (el: HTMLDivElement | null) => void;
  onSelectWorkspace: (index: number) => void;
  onDoubleClick: (e: React.MouseEvent) => void;
  onPointerDown: (e: React.PointerEvent) => void;
  onEditChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onEditBlur: () => void;
  onEditKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onEditClick: (e: React.MouseEvent) => void;
  onEditPointerDown: (e: React.PointerEvent) => void;
}

const WorkspaceItem = React.forwardRef<
  HTMLDivElement,
  WorkspaceItemProps & React.HTMLAttributes<HTMLDivElement>
>(function WorkspaceItem(
  {
    ws,
    idx,
    isSelected,
    selectedWorkspaceIndex,
    isDragging,
    isDeleting,
    isEditing,
    editValue,
    editRef,
    displayName,
    getTransformStyle,
    justDragged,
    itemRefCallback,
    onSelectWorkspace,
    onDoubleClick,
    onPointerDown,
    onEditChange,
    onEditBlur,
    onEditKeyDown,
    onEditClick,
    onEditPointerDown,
    ...rest
  },
  forwardedRef,
) {
  const workspaceStatus = useWorkspaceAgentStatus(ws.path);

  return (
    <div
      ref={(el) => {
        itemRefCallback(el);
        if (typeof forwardedRef === "function") forwardedRef(el);
        else if (forwardedRef) forwardedRef.current = el;
      }}
      {...rest}
      className={`${styles.workspace} ${
        isSelected && idx === selectedWorkspaceIndex
          ? styles.workspaceActive
          : ""
      } ${isDragging ? styles.workspaceDragging : ""} ${isDeleting ? styles.workspaceDeleting : ""}${rest.className ? ` ${rest.className}` : ""}`}
      style={{ ...getTransformStyle(idx), ...rest.style }}
      onClick={(e) => {
        if (!justDragged.current) onSelectWorkspace(idx);
        rest.onClick?.(e);
      }}
      onDoubleClick={(e) => {
        onDoubleClick(e);
        rest.onDoubleClick?.(e);
      }}
      onPointerDown={(e) => {
        onPointerDown(e);
        rest.onPointerDown?.(e);
      }}
    >
      {isEditing ? (
        <input
          ref={editRef}
          className={styles.workspaceNameInput}
          value={editValue}
          onChange={onEditChange}
          onBlur={onEditBlur}
          onKeyDown={onEditKeyDown}
          onClick={onEditClick}
          onPointerDown={onEditPointerDown}
        />
      ) : (
        <>
          <span className={styles.workspaceIcon}>
            {workspaceStatus ? (
              <AgentDot status={workspaceStatus} size="sidebar" />
            ) : ws.isMain ? (
              <House size={12} />
            ) : (
              <FolderGit2 size={12} />
            )}
          </span>
          <div className={styles.workspaceLabel}>
            <div className={styles.workspaceNameRow}>
              <span className={styles.workspaceName}>{displayName}</span>
              {ws.diffStats &&
                (ws.diffStats.added > 0 || ws.diffStats.removed > 0) && (
                  <span className={styles.diffStats}>
                    {ws.diffStats.added > 0 && (
                      <span className={styles.diffAdded}>
                        +{ws.diffStats.added}
                      </span>
                    )}
                    {ws.diffStats.removed > 0 && (
                      <span className={styles.diffRemoved}>
                        -{ws.diffStats.removed}
                      </span>
                    )}
                  </span>
                )}
            </div>
            <div className={styles.workspaceBranchRow}>
              <span className={styles.workspaceBranch}>
                {ws.branch || "main"}
              </span>
              {ws.pr && (
                <PrPopover
                  pr={ws.pr}
                  onOpen={() =>
                    window.electronAPI.shell.openExternal(ws.pr!.url)
                  }
                />
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
});

export function ProjectItem({
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
  onOpenSettings,
  onDragStart,
  onQuickMergeWorktree,
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
  onOpenSettings?: () => void;
  onDragStart?: (e: ReactPointerEvent) => void;
  onQuickMergeWorktree?: (ws: WorkspaceInfo) => void;
}) {
  const expanded = !collapsed;
  const [editingPath, setEditingPath] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [confirmDeleteWorktree, setConfirmDeleteWorktree] =
    useState<WorkspaceInfo | null>(null);
  const [newWorkspaceOpen, setNewWorkspaceOpen] = useState(false);
  const [deletingPaths, setDeletingPaths] = useState<Set<string>>(new Set());
  const [mergeState, setMergeState] = useState<{
    canMerge: boolean;
    reason?: string;
  } | null>(null);
  const editRef = useRef<HTMLInputElement>(null);

  const {
    dragIndex,
    handleDragStart,
    getTransformStyle,
    justDragged,
    itemRefs,
  } = useWorkspaceDrag({
    workspaces: project.workspaces,
    onReorderWorkspaces,
    editingPath,
  });

  const projectStatus = useProjectAgentStatus(project);

  const startRename = useCallback((ws: WorkspaceInfo) => {
    setEditingPath(ws.path);
    setEditValue(ws.name || ws.branch || "");
    requestAnimationFrame(() => {
      editRef.current?.focus();
      editRef.current?.select();
    });
  }, []);

  const commitRename = useCallback(
    (ws: WorkspaceInfo) => {
      setEditingPath(null);
      onRenameWorkspace(ws, editValue);
    },
    [editValue, onRenameWorkspace],
  );

  return (
    <div
      className={`${styles.project} ${isSelected ? styles.projectSelected : ""}`}
      style={
        project.color
          ? ({
              "--project-color": `var(--${project.color})`,
            } as React.CSSProperties)
          : undefined
      }
    >
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
            <span
              className={`${styles.projectChevron} ${expanded ? styles.projectChevronOpen : ""}`}
            >
              <ChevronRight size={12} />
            </span>
            <span className={styles.projectName} title={project.path}>
              {project.name}
            </span>
            {collapsed && projectStatus && (
              <AgentDot status={projectStatus} size="sidebar" />
            )}
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
              className={styles.contextMenuItem}
              onSelect={() => onOpenSettings?.()}
            >
              Project Settings
            </ContextMenu.Item>
            <ContextMenu.Separator className={styles.contextMenuSeparator} />
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
              <WorkspaceItem
                key={ws.path}
                ws={ws}
                idx={idx}
                isSelected={isSelected}
                selectedWorkspaceIndex={project.selectedWorkspaceIndex}
                isDragging={isDragging}
                isDeleting={isDeleting}
                isEditing={isEditing}
                editValue={editValue}
                editRef={editRef}
                displayName={displayName}
                getTransformStyle={getTransformStyle}
                justDragged={justDragged}
                itemRefCallback={(el) => {
                  if (el) itemRefs.current.set(idx, el);
                  else itemRefs.current.delete(idx);
                }}
                onSelectWorkspace={onSelectWorkspace}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  startRename(ws);
                }}
                onPointerDown={(e) => handleDragStart(idx, e)}
                onEditChange={(e) => setEditValue(e.target.value)}
                onEditBlur={() => {
                  if (editingPath) commitRename(ws);
                }}
                onEditKeyDown={(e) => {
                  if (e.key === "Enter") commitRename(ws);
                  if (e.key === "Escape") {
                    setEditingPath(null);
                    e.currentTarget.blur();
                  }
                }}
                onEditClick={(e) => e.stopPropagation()}
                onEditPointerDown={(e) => e.stopPropagation()}
              />
            );

            return (
              <React.Fragment key={ws.path}>
                <ContextMenu.Root
                  onOpenChange={(open) => {
                    if (open && !ws.isMain) {
                      setMergeState(null);
                      useProjectStore
                        .getState()
                        .canQuickMerge(project.id, ws.path)
                        .then(setMergeState)
                        .catch(() =>
                          setMergeState({ canMerge: false, reason: "Error checking merge eligibility" }),
                        );
                    } else {
                      setMergeState(null);
                    }
                  }}
                >
                  <ContextMenu.Trigger asChild>
                    {workspaceEl}
                  </ContextMenu.Trigger>
                  <ContextMenu.Portal>
                    <ContextMenu.Content className={styles.contextMenu}>
                      <ContextMenu.Item
                        className={styles.contextMenuItem}
                        onSelect={() =>
                          window.electronAPI.shell.openExternal(
                            `file://${ws.path}`,
                          )
                        }
                      >
                        Open in Finder
                      </ContextMenu.Item>
                      <ContextMenu.Item
                        className={styles.contextMenuItem}
                        onSelect={() =>
                          window.electronAPI.shell.openInEditor(ws.path)
                        }
                      >
                        Open in Editor
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
                          {(mergeState === null || mergeState.canMerge) && (
                            <ContextMenu.Item
                              className={`${styles.contextMenuItem} ${styles.contextMenuItemDanger}`}
                              disabled={mergeState === null}
                              onSelect={() => onQuickMergeWorktree?.(ws)}
                            >
                              Merge & Delete
                            </ContextMenu.Item>
                          )}
                          <ContextMenu.Item
                            className={`${styles.contextMenuItem} ${mergeState?.canMerge !== false ? styles.contextMenuItemDanger : ""}`}
                            disabled={!mergeState?.canMerge}
                            onSelect={() => onQuickMergeWorktree?.(ws)}
                          >
                            Merge & Delete
                            {mergeState && !mergeState.canMerge && (
                              <span className={styles.contextMenuItemHint}>
                                {mergeState.reason}
                              </span>
                            )}
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
              </React.Fragment>
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

      <RemoveProjectDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        projectName={project.name}
        onConfirm={onRemove}
      />

      <DeleteWorktreeDialog
        open={confirmDeleteWorktree !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmDeleteWorktree(null);
        }}
        workspace={confirmDeleteWorktree}
        onConfirm={(ws, deleteBranch) => {
          setDeletingPaths((prev) => new Set(prev).add(ws.path));
          onRemoveWorktree(ws, deleteBranch);
        }}
      />
    </div>
  );
}
