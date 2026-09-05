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
import { groupWorkspaces, mergeSectionOrder } from "../../utils/workspace-folders";
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
import { WorkspaceList, type WorkspaceDragProps } from "./WorkspaceList";
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
      style={{ ...getTransformStyle(idx), ...rest.style }}
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
  onReorderWorkspaces: (orderedPaths: string[]) => void;
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
    onReorderWorkspaces,
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
  const [convertWorkspaceOpen, setConvertWorkspaceOpen] = useState(false);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  // Set when "New Folder…" is picked from a workspace's menu: the folder is
  // created and that workspace moved into it in one step.
  const [pendingMovePath, setPendingMovePath] = useState<string | null>(null);
  const [deletingPaths, setDeletingPaths] = useState<Set<string>>(new Set());

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
  const setWorkspaceFolder = useProjectStore((s) => s.setWorkspaceFolder);

  const { status: projectStatus, pulse: projectPulse } = useProjectAgentStatus(project);
  const mainWorkspace = project.workspaces.find((ws) => ws.isMain);
  const hiddenWorkspaces = project.workspaces.filter((ws) => ws.hidden);

  const { workspaces, folders } = project;
  const grouped = useMemo(
    () => groupWorkspaces({ workspaces, folders }),
    [workspaces, folders],
  );
  const selectedWorkspace = project.workspaces[project.selectedWorkspaceIndex];

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

  // A drag inside one section reorders only that section's slots; the rest of
  // `project.workspaces` keeps its order.
  const handleSectionReorder = useCallback(
    (sectionPaths: string[]) => {
      onReorderWorkspaces(
        mergeSectionOrder(
          project.workspaces.map((ws) => ws.path),
          sectionPaths,
        ),
      );
    },
    [project.workspaces, onReorderWorkspaces],
  );

  const renderWorkspace = (ws: WorkspaceInfo, drag: WorkspaceDragProps) => {
    // Every callback below the sidebar takes the index into
    // `project.workspaces`; `drag.idx` is section-local and only feeds the
    // drag hook that owns this section.
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
        isDragging={drag.isDragging}
        isDeleting={isDeleting}
        isEditing={isEditing}
        editValue={editValue}
        editRef={editRef}
        displayName={displayName}
        getTransformStyle={() => drag.getTransformStyle(drag.idx)}
        justDragged={drag.justDragged}
        itemRefCallback={drag.itemRefCallback}
        onSelectWorkspace={onSelectWorkspace}
        onDoubleClick={(e) => {
          e.stopPropagation();
          startRename(ws);
        }}
        onPointerDown={drag.onPointerDown}
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
                        setWorkspaceFolder(project.id, ws.path, folder.id)
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
                onSelect={() => setWorkspaceFolder(project.id, ws.path, null)}
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
      {expanded && (
        <>
          {grouped.loose.length > 0 && (
            <WorkspaceList
              workspaces={grouped.loose}
              editingPath={editingPath}
              onReorder={handleSectionReorder}
              renderWorkspace={renderWorkspace}
            />
          )}
          {grouped.folders.map(({ folder, workspaces }) => (
            <FolderItem
              key={folder.id}
              folder={folder}
              workspaces={workspaces}
              collapsed={collapsedFolderKeys.has(
                folderCollapseKey(project.id, folder.id),
              )}
              containsSelected={
                isSelected &&
                !!selectedWorkspace &&
                workspaces.includes(selectedWorkspace)
              }
              onToggleCollapsed={() =>
                toggleFolderCollapsed(project.id, folder.id)
              }
              onRename={(name) =>
                renameWorkspaceFolder(project.id, folder.id, name)
              }
              onDelete={() => deleteWorkspaceFolder(project.id, folder.id)}
            >
              <WorkspaceList
                workspaces={workspaces}
                editingPath={editingPath}
                onReorder={handleSectionReorder}
                renderWorkspace={renderWorkspace}
              />
            </FolderItem>
          ))}
        </>
      )}

      <NewWorkspaceDialog
        open={newWorkspaceOpen}
        onClose={() => setNewWorkspaceOpen(false)}
        projects={[project]}
        selectedProjectIndex={0}
        onSubmit={async (_projectId, name, branch, baseBranch, useExistingBranch) => {
          const result = await onCreateWorktree(name, branch, baseBranch, useExistingBranch);
          if (result) {
            setNewWorkspaceOpen(false);
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
          const folder = await createWorkspaceFolder(project.id, name);
          if (folder && movePath) {
            await setWorkspaceFolder(project.id, movePath, folder.id);
          }
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
