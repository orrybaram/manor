import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import Check from "lucide-react/dist/esm/icons/check";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import GitBranch from "lucide-react/dist/esm/icons/git-branch";
import FolderGit2 from "lucide-react/dist/esm/icons/folder-git-2";
import {
  folderCollapseKey,
  useProjectStore,
  type ProjectInfo,
  type WorkspaceInfo,
} from "../../store/project-store";
import {
  applyDrop,
  buildSidebarItems,
  placeAfterFolder,
  placeInFolder,
  type DropTarget,
  type Row,
} from "../../utils/sidebar-items";
import { headerRefKey, useSidebarDrag } from "../../hooks/useSidebarDrag";
import { useProjectAgentStatus } from "../../hooks/useProjectAgentStatus";
import { useWorkspaceAgentStatus } from "../../hooks/useWorkspaceAgentStatus";
import { AgentDot } from "../ui/AgentDot/AgentDot";
import { NewWorkspaceDialog } from "./NewWorkspaceDialog/NewWorkspaceDialog";
import { PrPopover } from "./PrPopover";
import { RemoveProjectDialog } from "./RemoveProjectDialog";
import { DeleteWorktreeDialog } from "./DeleteWorktreeDialog";
import { MergeWorktreeDialog } from "./MergeWorktreeDialog";
import { ConvertToWorkspaceDialog } from "./ConvertToWorkspaceDialog";
import { NewFolderDialog } from "./NewFolderDialog";
import { FolderItem } from "./FolderItem";
import { openInEditor } from "../../lib/editor";
import styles from "./ProjectItem.module.css";

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
  /** Transform supplied by the sidebar drag while a drag is in flight. */
  dragStyle: React.CSSProperties | undefined;
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
  onOpenDiff?: () => void;
}

const WorkspaceItem = React.forwardRef<
  HTMLDivElement,
  WorkspaceItemProps & React.HTMLAttributes<HTMLDivElement>
>(function WorkspaceItem(
  props,
  forwardedRef,
) {
  const {
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
    dragStyle,
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
    onOpenDiff,
    ...rest
  } = props;

  const { status: workspaceStatus, pulse: workspacePulse } = useWorkspaceAgentStatus(ws.path);

  return (
    <div
      ref={(el) => {
        itemRefCallback(el);
        if (typeof forwardedRef === "function") forwardedRef(el);
        else if (forwardedRef) forwardedRef.current = el;
      }}
      data-testid="workspace-item"
      data-workspace-path={ws.path}
      {...rest}
      className={`${styles.workspace} ${isSelected && idx === selectedWorkspaceIndex
          ? styles.workspaceActive
          : ""
        } ${isDragging ? styles.workspaceDragging : ""} ${isDeleting ? styles.workspaceDeleting : ""}${rest.className ? ` ${rest.className}` : ""}`}
      style={{ ...dragStyle, ...rest.style }}
      onClick={(e) => {
        if (!justDragged.current) onSelectWorkspace(idx);
        rest.onClick?.(e);
      }}
      onDoubleClick={onDoubleClick}
      onPointerDown={onPointerDown}
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
              <AgentDot status={workspaceStatus} size="sidebar" pulse={workspacePulse} />
            ) : ws.isMain ? (
              <GitBranch size={12} />
            ) : (
              <FolderGit2 size={12} />
            )}
          </span>
          <div className={styles.workspaceLabel}>
            <div className={styles.workspaceNameRow}>
              <span className={styles.workspaceName}>{displayName}</span>
              {ws.diffStats &&
                (ws.diffStats.added > 0 || ws.diffStats.removed > 0) && (
                  <span
                    className={`${styles.diffStats} ${styles.diffStatsClickable}`}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenDiff?.();
                    }}
                  >
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

type ProjectItemProps = {
  project: ProjectInfo;
  isSelected: boolean;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onSelect: () => void;
  onRemove: () => void;
  onSelectWorkspace: (index: number) => void;
  onRemoveWorktree: (ws: WorkspaceInfo, deleteBranch: boolean) => void;
  onRenameWorkspace: (ws: WorkspaceInfo, newName: string) => void;
  onHideWorkspace: (ws: WorkspaceInfo, idx: number) => void;
  onUnhideWorkspace: (ws: WorkspaceInfo) => void;
  onCreateWorktree: (name: string, branch: string, baseBranch?: string, useExistingBranch?: boolean) => Promise<string | null>;
  onOpenSettings?: () => void;
  onDragStart?: (e: ReactPointerEvent) => void;
  onQuickMergeWorktree?: (ws: WorkspaceInfo) => void;
  onOpenDiff?: (wsIndex: number) => void;
};

export function ProjectItem(props: ProjectItemProps) {
  const {
    project,
    isSelected,
    collapsed,
    onToggleCollapsed,
    onSelect: _onSelect,
    onRemove,
    onSelectWorkspace,
    onRemoveWorktree,
    onRenameWorkspace,
    onHideWorkspace,
    onUnhideWorkspace,
    onCreateWorktree,
    onOpenSettings,
    onDragStart,
    onQuickMergeWorktree,
    onOpenDiff,
  } = props;

  const expanded = !collapsed;
  const [editingPath, setEditingPath] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [confirmDeleteWorktree, setConfirmDeleteWorktree] =
    useState<WorkspaceInfo | null>(null);
  const [confirmMergeWorktree, setConfirmMergeWorktree] =
    useState<WorkspaceInfo | null>(null);
  const [newWorkspaceOpen, setNewWorkspaceOpen] = useState(false);
  // Folder chosen via its context menu's "New Workspace…"; the created
  // workspace is placed inside it once the worktree exists.
  const [newWorkspaceFolderId, setNewWorkspaceFolderId] = useState<string | null>(null);
  const [convertWorkspaceOpen, setConvertWorkspaceOpen] = useState(false);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  // Set when "New Folder…" is picked from a workspace's menu: the folder is
  // created and that workspace moved into it in one step.
  const [pendingMovePath, setPendingMovePath] = useState<string | null>(null);
  const [deletingPaths, setDeletingPaths] = useState<Set<string>>(new Set());
  // A folder's inline rename input, like a workspace's, suspends dragging.
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null);

  // Keep a path dimmed until the workspace is actually gone. Only prune paths
  // that no longer exist — a workspaces refresh mid-deletion (e.g. git status
  // poll) must not un-dim an item whose deletion is still in flight.
  useEffect(() => {
    setDeletingPaths((prev) => {
      if (prev.size === 0) return prev;
      const existing = new Set(project.workspaces.map((ws) => ws.path));
      const next = new Set([...prev].filter((path) => existing.has(path)));
      return next.size === prev.size ? prev : next;
    });
  }, [project.workspaces]);

  const [mergeState, setMergeState] = useState<{
    canMerge: boolean;
    reason?: string;
  } | null>(null);
  const editRef = useRef<HTMLInputElement>(null);

  const collapsedFolderKeys = useProjectStore((s) => s.collapsedFolderKeys);
  const toggleFolderCollapsed = useProjectStore((s) => s.toggleFolderCollapsed);
  const createWorkspaceFolder = useProjectStore((s) => s.createWorkspaceFolder);
  const renameWorkspaceFolder = useProjectStore((s) => s.renameWorkspaceFolder);
  const deleteWorkspaceFolder = useProjectStore((s) => s.deleteWorkspaceFolder);
  const applySidebarChange = useProjectStore((s) => s.applySidebarChange);

  const { status: projectStatus, pulse: projectPulse } = useProjectAgentStatus(project);
  const mainWorkspace = project.workspaces.find((ws) => ws.isMain);
  const hiddenWorkspaces = project.workspaces.filter((ws) => ws.hidden);

  const { id: projectId, workspaces, folders, sidebarOrder } = project;
  const items = useMemo(
    () => buildSidebarItems({ workspaces, folders, sidebarOrder }),
    [workspaces, folders, sidebarOrder],
  );
  const collapsedFolderIds = useMemo(() => {
    const ids = new Set<string>();
    for (const folder of folders) {
      if (collapsedFolderKeys.has(folderCollapseKey(projectId, folder.id))) {
        ids.add(folder.id);
      }
    }
    return ids;
  }, [folders, collapsedFolderKeys, projectId]);
  const selectedWorkspace = project.workspaces[project.selectedWorkspaceIndex];

  const handleDrop = useCallback(
    (sourceKey: string, target: DropTarget, rows: Row[]) => {
      applySidebarChange(projectId, applyDrop(items, sourceKey, target, rows));
    },
    [applySidebarChange, projectId, items],
  );

  const {
    dragKey,
    intoFolderId,
    justDragged,
    rowRefs,
    handleDragStart,
    getTransformStyle,
  } = useSidebarDrag({
    items,
    collapsedFolderIds,
    disabled: editingPath !== null || editingFolderId !== null,
    onDrop: handleDrop,
  });

  const registerRow = (key: string) => (el: HTMLElement | null) => {
    if (el) rowRefs.current.set(key, el);
    else rowRefs.current.delete(key);
  };

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

  const renderWorkspace = (ws: WorkspaceInfo) => {
    // Every callback below the sidebar takes the index into
    // `project.workspaces`; the drag itself is keyed by path.
    const globalIdx = project.workspaces.indexOf(ws);
    const isEditing = editingPath === ws.path;
    const displayName = ws.isMain
      ? ws.name || "local"
      : ws.name || ws.branch || "main";
    const isDeleting = deletingPaths.has(ws.path);

    const workspaceEl = (
      <WorkspaceItem
        ws={ws}
        idx={globalIdx}
        isSelected={isSelected}
        selectedWorkspaceIndex={project.selectedWorkspaceIndex}
        isDragging={dragKey === ws.path}
        isDeleting={isDeleting}
        isEditing={isEditing}
        editValue={editValue}
        editRef={editRef}
        displayName={displayName}
        dragStyle={getTransformStyle(ws.path)}
        justDragged={justDragged}
        itemRefCallback={registerRow(ws.path)}
        onSelectWorkspace={onSelectWorkspace}
        onDoubleClick={(e) => {
          e.stopPropagation();
          startRename(ws);
        }}
        onPointerDown={(e) => handleDragStart(ws.path, "workspace", e)}
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
        onOpenDiff={() => onOpenDiff?.(globalIdx)}
      />
    );

    return (
      <ContextMenu.Root
        key={ws.path}
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
              onSelect={() => openInEditor(ws.path)}
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
            {ws.isMain && ws.branch && ws.branch !== project.defaultBranch && (
              <>
                <ContextMenu.Separator className={styles.contextMenuSeparator} />
                <ContextMenu.Item
                  className={styles.contextMenuItem}
                  onSelect={() => setConvertWorkspaceOpen(true)}
                >
                  Convert to Workspace…
                </ContextMenu.Item>
              </>
            )}
            <ContextMenu.Separator className={styles.contextMenuSeparator} />
            <ContextMenu.Sub>
              <ContextMenu.SubTrigger
                className={styles.contextMenuItem}
                style={{ display: "flex", alignItems: "center" }}
              >
                Move to Folder
                <ChevronRight size={14} style={{ marginLeft: "auto" }} />
              </ContextMenu.SubTrigger>
              <ContextMenu.Portal>
                <ContextMenu.SubContent
                  className={styles.contextMenu}
                  style={{ maxWidth: 220 }}
                >
                  {project.folders.map((folder) => (
                    <ContextMenu.Item
                      key={folder.id}
                      className={styles.contextMenuItem}
                      style={{ display: "flex", alignItems: "center", gap: 6 }}
                      disabled={ws.folderId === folder.id}
                      onSelect={() =>
                        applySidebarChange(
                          projectId,
                          placeInFolder(items, ws.path, folder.id),
                        )
                      }
                    >
                      {ws.folderId === folder.id && <Check size={12} />}
                      {folder.name}
                    </ContextMenu.Item>
                  ))}
                  {project.folders.length > 0 && (
                    <ContextMenu.Separator
                      className={styles.contextMenuSeparator}
                    />
                  )}
                  <ContextMenu.Item
                    className={styles.contextMenuItem}
                    onSelect={() => {
                      setPendingMovePath(ws.path);
                      setNewFolderOpen(true);
                    }}
                  >
                    New Folder…
                  </ContextMenu.Item>
                </ContextMenu.SubContent>
              </ContextMenu.Portal>
            </ContextMenu.Sub>
            {ws.folderId && (
              <ContextMenu.Item
                className={styles.contextMenuItem}
                onSelect={() =>
                  applySidebarChange(
                    projectId,
                    placeAfterFolder(items, ws.path, ws.folderId!),
                  )
                }
              >
                Remove from Folder
              </ContextMenu.Item>
            )}
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
                  className={styles.contextMenuItem}
                  onSelect={() => onHideWorkspace(ws, globalIdx)}
                >
                  Hide Workspace
                </ContextMenu.Item>
                {ws.pr?.state?.toLowerCase() !== "merged" && (
                  <ContextMenu.Item
                    className={`${styles.contextMenuItem} ${styles.contextMenuItemDanger}`}
                    disabled={mergeState === null || !mergeState.canMerge}
                    onSelect={() => setConfirmMergeWorktree(ws)}
                  >
                    Merge & Delete
                    {mergeState && !mergeState.canMerge && mergeState.reason && (
                      <span className={styles.contextMenuItemHint}>
                        {mergeState.reason}
                      </span>
                    )}
                  </ContextMenu.Item>
                )}
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
  };

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
              <AgentDot status={projectStatus} size="sidebar" pulse={projectPulse} />
            )}
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
              onSelect={() => {
                setPendingMovePath(null);
                setNewFolderOpen(true);
              }}
            >
              New Folder…
            </ContextMenu.Item>
            <ContextMenu.Item
              className={styles.contextMenuItem}
              onSelect={() => onOpenSettings?.()}
            >
              Project Settings
            </ContextMenu.Item>
            {hiddenWorkspaces.length > 0 && (
              <ContextMenu.Sub>
                <ContextMenu.SubTrigger
                  className={styles.contextMenuItem}
                  style={{ display: "flex", alignItems: "center" }}
                >
                  Hidden ({hiddenWorkspaces.length})
                  <ChevronRight size={14} style={{ marginLeft: "auto" }} />
                </ContextMenu.SubTrigger>
                <ContextMenu.Portal>
                  <ContextMenu.SubContent
                    className={styles.contextMenu}
                    style={{ maxWidth: 220 }}
                  >
                    {hiddenWorkspaces.map((ws) => (
                      <ContextMenu.Item
                        key={ws.path}
                        className={styles.contextMenuItem}
                        onSelect={() => onUnhideWorkspace(ws)}
                      >
                        <div className={styles.workspaceLabel}>
                          <span className={styles.workspaceName}>
                            {ws.name || ws.branch || "main"}
                          </span>
                          <span className={styles.workspaceBranch}>
                            {ws.branch || "main"}
                          </span>
                        </div>
                      </ContextMenu.Item>
                    ))}
                  </ContextMenu.SubContent>
                </ContextMenu.Portal>
              </ContextMenu.Sub>
            )}
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
      {expanded && items.length > 0 && (
        <div className={styles.workspaces}>
          {items.map((item) =>
            item.kind === "workspace" ? (
              renderWorkspace(item.ws)
            ) : (
              <FolderItem
                key={item.folder.id}
                folder={item.folder}
                workspaces={item.workspaces}
                collapsed={collapsedFolderIds.has(item.folder.id)}
                containsSelected={
                  isSelected &&
                  !!selectedWorkspace &&
                  item.workspaces.includes(selectedWorkspace)
                }
                dropTarget={intoFolderId === item.folder.id}
                isDragging={dragKey === item.folder.id}
                onToggleCollapsed={() =>
                  toggleFolderCollapsed(projectId, item.folder.id)
                }
                onRename={(name) =>
                  renameWorkspaceFolder(projectId, item.folder.id, name)
                }
                onDelete={() => deleteWorkspaceFolder(projectId, item.folder.id)}
                onNewWorkspace={() => {
                  setNewWorkspaceFolderId(item.folder.id);
                  setNewWorkspaceOpen(true);
                }}
                onDragStart={(e) =>
                  handleDragStart(item.folder.id, "folder", e)
                }
                registerBlock={registerRow(item.folder.id)}
                registerHeader={registerRow(headerRefKey(item.folder.id))}
                style={getTransformStyle(item.folder.id)}
                headerStyle={getTransformStyle(headerRefKey(item.folder.id))}
                justDragged={justDragged}
                onEditingChange={(editing) =>
                  setEditingFolderId((current) =>
                    editing
                      ? item.folder.id
                      : current === item.folder.id
                        ? null
                        : current,
                  )
                }
              >
                {item.workspaces.length > 0 && (
                  <div className={styles.folderMembers}>
                    {item.workspaces.map((ws) => renderWorkspace(ws))}
                  </div>
                )}
              </FolderItem>
            ),
          )}
        </div>
      )}

      <NewWorkspaceDialog
        open={newWorkspaceOpen}
        onClose={() => {
          setNewWorkspaceOpen(false);
          setNewWorkspaceFolderId(null);
        }}
        projects={[project]}
        selectedProjectIndex={0}
        onSubmit={async (_projectId, name, branch, baseBranch, useExistingBranch) => {
          const result = await onCreateWorktree(name, branch, baseBranch, useExistingBranch);
          if (result) {
            const targetFolderId = newWorkspaceFolderId;
            setNewWorkspaceOpen(false);
            setNewWorkspaceFolderId(null);
            if (targetFolderId) {
              // Read the freshly updated project: the store has already
              // merged the new worktree (and its normalized sidebarOrder).
              const fresh = useProjectStore
                .getState()
                .projects.find((p) => p.id === projectId);
              if (fresh) {
                await applySidebarChange(
                  projectId,
                  placeInFolder(buildSidebarItems(fresh), result, targetFolderId),
                );
              }
            }
          }
          return !!result;
        }}
      />

      <NewFolderDialog
        open={newFolderOpen}
        onOpenChange={(open) => {
          setNewFolderOpen(open);
          if (!open) setPendingMovePath(null);
        }}
        onConfirm={async (name) => {
          setNewFolderOpen(false);
          const movePath = pendingMovePath;
          setPendingMovePath(null);
          await createWorkspaceFolder(projectId, name, movePath ?? undefined);
        }}
      />

      <RemoveProjectDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        projectName={project.name}
        onConfirm={onRemove}
      />

      <MergeWorktreeDialog
        open={confirmMergeWorktree !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmMergeWorktree(null);
        }}
        workspace={confirmMergeWorktree}
        defaultBranch={project.defaultBranch}
        onConfirm={(ws) => onQuickMergeWorktree?.(ws)}
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

      <ConvertToWorkspaceDialog
        key={mainWorkspace?.branch || ""}
        open={convertWorkspaceOpen}
        onOpenChange={setConvertWorkspaceOpen}
        branch={mainWorkspace?.branch || ""}
        onConfirm={async (name) => {
          setConvertWorkspaceOpen(false);
          const branch = mainWorkspace?.branch || "";
          await useProjectStore.getState().convertMainToWorktree(project.id, name, branch);
        }}
      />
    </div>
  );
}
