import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
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
import { useAppStore } from "../../store/app-store";
import {
  applyDrop,
  buildSidebarItems,
  descendantWorkspaces,
  placeAfterFolder,
  placeInFolder,
  type DropTarget,
  type Row,
  type SidebarItem,
} from "../../utils/sidebar-items";
import { headerRefKey, useSidebarDrag } from "../../hooks/useSidebarDrag";
import { useProjectAgentStatus } from "../../hooks/useProjectAgentStatus";
import { useWorkspaceAgentStatus } from "../../hooks/useWorkspaceAgentStatus";
import { toWorkspaceIndicator } from "../../lib/workspace-indicator";
import { WorkspaceIndicatorDot } from "./WorkspaceIndicatorDot";
import { NewWorkspaceDialog } from "./NewWorkspaceDialog/NewWorkspaceDialog";
import { PrPopover } from "./PrPopover";
import { RemoveProjectDialog } from "./RemoveProjectDialog";
import { DeleteWorktreeDialog } from "./DeleteWorktreeDialog";
import { MergeWorktreeDialog } from "./MergeWorktreeDialog";
import { ConvertToWorkspaceDialog } from "./ConvertToWorkspaceDialog";
import { NewFolderDialog } from "./NewFolderDialog";
import { FolderItem } from "./FolderItem";
import { placeNewWorkspaceInFolder } from "../../lib/place-new-workspace";
import { openInEditor } from "../../lib/editor";
import { isWebApp } from "../../lib/platform";
import { onUiRequest, type UiRequest } from "../../utils/ui-request";
import { handleSidebarRowKeyDown } from "../../lib/sidebar-row";
import {
  openContextMenuFromKeyboard,
} from "../../lib/keyboard-context-menu";
import { useEmojiAutocomplete } from "../ui/EmojiAutocomplete/useEmojiAutocomplete";
import { composeHandlers } from "../ui/EmojiAutocomplete/compose";
import { Button } from "../ui/Button/Button";
import styles from "./ProjectItem.module.css";

interface WorkspaceItemProps {
  ws: WorkspaceInfo;
  idx: number;
  /** True for the workspace currently open — matched by path, never by index. */
  isActive: boolean;
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
  onRowKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void;
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
    isActive,
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
    onRowKeyDown,
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
  const workspaceIndicator = toWorkspaceIndicator(workspaceStatus, workspacePulse);
  const {
    handleKeyDown: handleEmojiKeyDown,
    fieldProps: emojiFieldProps,
    suggestions: emojiSuggestions,
  } = useEmojiAutocomplete(editRef, { enabled: isEditing });

  return (
    <div
      ref={(el) => {
        itemRefCallback(el);
        if (typeof forwardedRef === "function") forwardedRef(el);
        else if (forwardedRef) forwardedRef.current = el;
      }}
      data-testid="workspace-item"
      data-workspace-path={ws.path}
      data-sidebar-row=""
      // The roving tabindex (useRovingRows) decides which row holds 0.
      tabIndex={-1}
      aria-current={isActive ? "true" : undefined}
      {...rest}
      className={`${styles.workspace} ${isActive
          ? styles.workspaceActive
          : ""
        } ${isDragging ? styles.workspaceDragging : ""} ${isDeleting ? styles.workspaceDeleting : ""}${rest.className ? ` ${rest.className}` : ""}`}
      style={{ ...dragStyle, ...rest.style }}
      onClick={(e) => {
        if (!justDragged.current) onSelectWorkspace(idx);
        rest.onClick?.(e);
      }}
      onKeyDown={(e) => {
        onRowKeyDown(e);
        rest.onKeyDown?.(e);
      }}
      onPointerDown={onPointerDown}
    >
      {isEditing ? (
        <>
          <input
            ref={editRef}
            className={styles.workspaceNameInput}
            data-testid="workspace-name-input"
            value={editValue}
            onChange={onEditChange}
            {...emojiFieldProps}
            onBlur={composeHandlers(emojiFieldProps.onBlur, onEditBlur)}
            onKeyDown={(e) => {
              if (handleEmojiKeyDown(e)) return;
              onEditKeyDown(e);
            }}
            onClick={onEditClick}
            onPointerDown={onEditPointerDown}
          />
          {emojiSuggestions}
        </>
      ) : (
        <>
          <span className={styles.workspaceIcon}>
            {workspaceIndicator ? (
              <WorkspaceIndicatorDot indicator={workspaceIndicator} />
            ) : ws.isMain ? (
              <GitBranch size={12} />
            ) : (
              <FolderGit2 size={12} />
            )}
          </span>
          <div className={styles.workspaceLabel}>
            <div className={styles.workspaceNameRow}>
              <span className={styles.workspaceName} data-testid="workspace-name">{displayName}</span>
              {ws.diffStats &&
                (ws.diffStats.added > 0 || ws.diffStats.removed > 0) && (
                  // A real button nested inside the row (ADR-175): the row's
                  // own key handler only acts when `e.target ===
                  // e.currentTarget`, so Enter/Space here open the diff
                  // instead of the workspace.
                  <Button
                    variant="ghost"
                    className={`${styles.diffStats} ${styles.diffStatsClickable}`}
                    aria-label="Open diff"
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
                  </Button>
                )}
            </div>
            <div className={styles.workspaceBranchRow}>
              <span className={styles.workspaceBranch}>
                {ws.branch || "main"}
              </span>
              {ws.pr && (
                <PrPopover
                  pr={ws.pr}
                  workspacePath={ws.path}
                  onOpen={() => openExternalUrl(ws.pr!.url)}
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

/**
 * `shell.openExternal` has no browser meaning (ADR-178), but "open this PR"
 * does — a plain `window.open` gets there without Electron, so this one call
 * site degrades instead of losing the feature entirely.
 */
function openExternalUrl(url: string): void {
  if (isWebApp()) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  void window.electronAPI.shell.openExternal(url);
}

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
  // The folder the next new folder belongs in: a folder's "New Folder Inside…",
  // or the folder the "New Folder…" anchor already lives in, so the new group
  // appears where it was asked for rather than at the top level (ADR-172).
  const [newFolderParentId, setNewFolderParentId] = useState<string | null>(null);
  const [deletingPaths, setDeletingPaths] = useState<Set<string>>(new Set());
  // A folder's inline rename input, like a workspace's, suspends dragging.
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null);

  // Keep a path dimmed until the workspace is actually gone. Only prune paths
  // that no longer exist — a workspaces refresh mid-deletion (e.g. git status
  // poll) must not un-dim an item whose deletion is still in flight. Pruned
  // during render (React's "adjust state when props change") so a deleted row
  // never renders dimmed for a frame after it comes back.
  const [prunedFor, setPrunedFor] = useState(project.workspaces);
  if (prunedFor !== project.workspaces) {
    setPrunedFor(project.workspaces);
    if (deletingPaths.size > 0) {
      const existing = new Set(project.workspaces.map((ws) => ws.path));
      const next = new Set(
        [...deletingPaths].filter((path) => existing.has(path)),
      );
      if (next.size !== deletingPaths.size) setDeletingPaths(next);
    }
  }

  const [mergeState, setMergeState] = useState<{
    canMerge: boolean;
    reason?: string;
  } | null>(null);
  const editRef = useRef<HTMLInputElement>(null);
  // Paths of workspace rows whose context menu was opened via the keyboard
  // (`openMenu`), so `onCloseAutoFocus` knows to return focus to the row; a
  // mouse-opened menu keeps Radix's own default (ADR-175).
  const workspaceMenuOpenedByKeyboard = useRef<Set<string>>(new Set());
  // Same, for the project header's own context menu.
  const projectMenuOpenedByKeyboard = useRef(false);
  const projectHeaderRef = useRef<HTMLDivElement | null>(null);

  const collapsedFolderKeys = useProjectStore((s) => s.collapsedFolderKeys);
  const toggleFolderCollapsed = useProjectStore((s) => s.toggleFolderCollapsed);
  const createWorkspaceFolder = useProjectStore((s) => s.createWorkspaceFolder);
  const renameWorkspaceFolder = useProjectStore((s) => s.renameWorkspaceFolder);
  const deleteWorkspaceFolder = useProjectStore((s) => s.deleteWorkspaceFolder);
  const applySidebarChange = useProjectStore((s) => s.applySidebarChange);

  const { status: projectStatus, pulse: projectPulse } = useProjectAgentStatus(project);
  const projectIndicator = toWorkspaceIndicator(projectStatus, projectPulse);
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
  // Every folder for the "Move to Folder" submenu, walked in tree order and
  // labelled by its full path, so a flat list of menu items still reads as the
  // tree it came from (ADR-172).
  const folderChoices = useMemo(() => {
    const choices: { id: string; label: string }[] = [];
    const walk = (list: SidebarItem[], trail: string[]) => {
      for (const item of list) {
        if (item.kind !== "folder") continue;
        const path = [...trail, item.folder.name];
        choices.push({ id: item.folder.id, label: path.join(" / ") });
        walk(item.children, path);
      }
    };
    walk(items, []);
    return choices;
  }, [items]);
  const activeWorkspacePath = useAppStore((s) => s.activeWorkspacePath);
  // Keyed by path, not by `selectedWorkspaceIndex`: that index addresses an
  // array the sidebar re-sorts on every reorder, so it drifts onto whichever
  // workspace now sits at the old position. A folder tinting itself accent
  // because a stale index landed inside it is the bug that made the highlight
  // look random. The active path is the thing the user is actually looking at.
  const selectedWorkspace = project.workspaces.find(
    (ws) => ws.path === activeWorkspacePath,
  );

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

  // Escape cancels and Enter commits by moving focus back to the row, and the
  // input's blur that follows must not commit (again). The blur handler's
  // `editingPath` is still the old value at that point (state has not
  // re-rendered yet), so the finished edit is flagged in a ref.
  const renameCancelled = useRef(false);

  /** Hand focus back to a workspace row once its rename input closes. */
  const focusWorkspaceRow = (path: string, input: HTMLInputElement) => {
    const row = rowRefs.current.get(path);
    if (row) row.focus();
    else input.blur();
  };

  const startRename = useCallback((ws: WorkspaceInfo) => {
    renameCancelled.current = false;
    setEditingPath(ws.path);
    setEditValue(ws.name || ws.branch || "");
    // A rename picked from a menu or the palette waits a frame: the menu
    // hands focus back to where it came from as it closes, and focusing the
    // input first would let that blur (and commit) it.
    requestAnimationFrame(() => {
      const input = editRef.current;
      if (!input || input === document.activeElement) return;
      input.focus();
      input.select();
    });
  }, []);

  // F2 on a focused row: nothing else is about to move focus, so the input
  // takes it in the commit that renders it. Waiting a frame left a window
  // where the input was on screen but the row still held focus, and a key
  // pressed then (Escape, the first letter of the name) went to the row,
  // which ignores keys while editing (ADR-175).
  useLayoutEffect(() => {
    if (!editingPath) return;
    const row = rowRefs.current.get(editingPath);
    if (!row || row !== document.activeElement) return;
    editRef.current?.focus();
    editRef.current?.select();
  }, [editingPath, rowRefs]);

  const commitRename = useCallback(
    (ws: WorkspaceInfo) => {
      setEditingPath(null);
      onRenameWorkspace(ws, editValue);
    },
    [editValue, onRenameWorkspace],
  );

  // Menu-driven actions (ADR-170 §8) arrive via the UI request bus rather
  // than props. The subscription must survive re-renders without
  // resubscribing, so the handler lives in a ref and the effect below
  // subscribes exactly once.
  const handleUiRequestRef = useRef<(request: UiRequest) => void>(() => {});
  handleUiRequestRef.current = (request: UiRequest) => {
    if (request.type === "remove-project") {
      if (request.projectId === projectId) setConfirmRemove(true);
      return;
    }
    if (
      request.type !== "rename-workspace" &&
      request.type !== "merge-worktree" &&
      request.type !== "delete-worktree"
    ) {
      return;
    }
    if (request.projectId !== projectId) return;
    const ws = project.workspaces.find((w) => w.path === request.path);
    if (!ws) return;
    switch (request.type) {
      case "rename-workspace":
        if (collapsed) onToggleCollapsed();
        startRename(ws);
        break;
      case "merge-worktree":
        setConfirmMergeWorktree(ws);
        break;
      case "delete-worktree":
        setConfirmDeleteWorktree(ws);
        break;
    }
  };

  useEffect(() => {
    return onUiRequest((request) => handleUiRequestRef.current(request));
  }, []);

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
        isActive={ws.path === activeWorkspacePath}
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
        onRowKeyDown={(e) => {
          if (isEditing) return;
          handleSidebarRowKeyDown(e, {
            activate: () => onSelectWorkspace(globalIdx),
            startRename: () => startRename(ws),
            openMenu: (row) => {
              workspaceMenuOpenedByKeyboard.current.add(ws.path);
              openContextMenuFromKeyboard(row);
            },
          });
        }}
        onPointerDown={(e) => handleDragStart(ws.path, "workspace", e)}
        onEditChange={(e) => setEditValue(e.target.value)}
        onEditBlur={() => {
          if (renameCancelled.current) {
            renameCancelled.current = false;
            return;
          }
          if (editingPath) commitRename(ws);
        }}
        onEditKeyDown={(e) => {
          // The input owns its plain keys while it is open — the row's own
          // handling would see them too. ⌘ / Ctrl combos carry on to the
          // app's shortcuts (ADR-175).
          if (!e.metaKey && !e.ctrlKey) e.stopPropagation();
          if (e.key === "Enter") {
            commitRename(ws);
            renameCancelled.current = true;
            focusWorkspaceRow(ws.path, e.currentTarget);
          }
          if (e.key === "Escape") {
            renameCancelled.current = true;
            setEditingPath(null);
            focusWorkspaceRow(ws.path, e.currentTarget);
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
        {/* While the rename input is open the trigger stands down, so a
            right-click inside it reaches the OS text-field menu instead of
            opening this menu — whose focus grab would blur the input and end
            the edit (ADR-172). */}
        <ContextMenu.Trigger asChild disabled={isEditing}>
          {workspaceEl}
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content
            className={styles.contextMenu}
            onCloseAutoFocus={(e) => {
              if (workspaceMenuOpenedByKeyboard.current.has(ws.path)) {
                e.preventDefault();
                rowRefs.current.get(ws.path)?.focus();
              }
              workspaceMenuOpenedByKeyboard.current.delete(ws.path);
            }}
          >
            {/* `shell.*` has no browser meaning (ADR-178) — removed, not
                disabled, following the remote client's rule for an
                affordance a paired device can't use at all. */}
            {!isWebApp() && (
              <>
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
              </>
            )}
            <ContextMenu.Sub>
              <ContextMenu.SubTrigger
                className={styles.contextMenuItem}
                style={{ display: "flex", alignItems: "center" }}
              >
                Copy
                <ChevronRight size={14} style={{ marginLeft: "auto" }} />
              </ContextMenu.SubTrigger>
              <ContextMenu.Portal>
                <ContextMenu.SubContent className={styles.contextMenu}>
                  <ContextMenu.Item
                    className={styles.contextMenuItem}
                    onSelect={() =>
                      navigator.clipboard.writeText(ws.branch || "main")
                    }
                  >
                    Branch Name
                  </ContextMenu.Item>
                  <ContextMenu.Item
                    className={styles.contextMenuItem}
                    onSelect={() => navigator.clipboard.writeText(ws.path)}
                  >
                    Path
                  </ContextMenu.Item>
                  {ws.pr && (
                    <ContextMenu.Item
                      className={styles.contextMenuItem}
                      onSelect={() => navigator.clipboard.writeText(ws.pr!.url)}
                    >
                      Pull Request Link
                    </ContextMenu.Item>
                  )}
                </ContextMenu.SubContent>
              </ContextMenu.Portal>
            </ContextMenu.Sub>
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
                  {folderChoices.map((choice) => (
                    <ContextMenu.Item
                      key={choice.id}
                      className={styles.contextMenuItem}
                      style={{ display: "flex", alignItems: "center", gap: 6 }}
                      disabled={ws.folderId === choice.id}
                      onSelect={() =>
                        applySidebarChange(
                          projectId,
                          placeInFolder(items, ws.path, choice.id),
                        )
                      }
                    >
                      {ws.folderId === choice.id && <Check size={12} />}
                      {choice.label}
                    </ContextMenu.Item>
                  ))}
                  {folderChoices.length > 0 && (
                    <ContextMenu.Separator
                      className={styles.contextMenuSeparator}
                    />
                  )}
                  <ContextMenu.Item
                    className={styles.contextMenuItem}
                    onSelect={() => {
                      setPendingMovePath(ws.path);
                      setNewFolderParentId(ws.folderId ?? null);
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

  // Folders nest (ADR-172), so a folder's body is the same renderer one level
  // down rather than a flat list of members.
  const renderItem = (item: SidebarItem, depth = 0): React.ReactNode => {
    if (item.kind === "workspace") return renderWorkspace(item.ws);
    const { folder, children } = item;
    const contents = descendantWorkspaces(item);
    return (
      <FolderItem
        key={folder.id}
        folder={folder}
        workspaces={contents}
        depth={depth}
        collapsed={collapsedFolderIds.has(folder.id)}
        containsSelected={
          !!selectedWorkspace && contents.includes(selectedWorkspace)
        }
        dropTarget={intoFolderId === folder.id}
        isDragging={dragKey === folder.id}
        onToggleCollapsed={() => toggleFolderCollapsed(projectId, folder.id)}
        onRename={(name) => renameWorkspaceFolder(projectId, folder.id, name)}
        onDelete={() => deleteWorkspaceFolder(projectId, folder.id)}
        onNewWorkspace={() => {
          setNewWorkspaceFolderId(folder.id);
          setNewWorkspaceOpen(true);
        }}
        onNewSubfolder={() => {
          setPendingMovePath(null);
          setNewFolderParentId(folder.id);
          setNewFolderOpen(true);
        }}
        onDragStart={(e) => handleDragStart(folder.id, "folder", e)}
        registerBlock={registerRow(folder.id)}
        registerHeader={registerRow(headerRefKey(folder.id))}
        style={getTransformStyle(folder.id)}
        headerStyle={getTransformStyle(headerRefKey(folder.id))}
        justDragged={justDragged}
        onEditingChange={(editing) =>
          setEditingFolderId((current) =>
            editing ? folder.id : current === folder.id ? null : current,
          )
        }
      >
        {children.length > 0 && (
          <div className={styles.folderMembers}>
            {children.map((child) => renderItem(child, depth + 1))}
          </div>
        )}
      </FolderItem>
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
            ref={projectHeaderRef}
            data-testid="project-header"
            data-sidebar-row=""
            tabIndex={-1}
            aria-expanded={expanded}
            className={styles.projectHeader}
            onClick={() => {
              onToggleCollapsed();
            }}
            onKeyDown={(e) =>
              handleSidebarRowKeyDown(e, {
                activate: onToggleCollapsed,
                setExpanded: (next) => {
                  if (next === collapsed) onToggleCollapsed();
                },
                openMenu: (row) => {
                  projectMenuOpenedByKeyboard.current = true;
                  openContextMenuFromKeyboard(row);
                },
              })
            }
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
            {collapsed && projectIndicator && (
              <WorkspaceIndicatorDot indicator={projectIndicator} />
            )}
          </div>
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content
            className={styles.contextMenu}
            onCloseAutoFocus={(e) => {
              if (projectMenuOpenedByKeyboard.current) {
                e.preventDefault();
                projectHeaderRef.current?.focus();
              }
              projectMenuOpenedByKeyboard.current = false;
            }}
          >
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
                setNewFolderParentId(null);
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
          {items.map((item) => renderItem(item, 0))}
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
        initialFolderId={newWorkspaceFolderId}
        onSubmit={async (_projectId, name, branch, baseBranch, useExistingBranch, folderId) => {
          const result = await onCreateWorktree(name, branch, baseBranch, useExistingBranch);
          if (result) {
            setNewWorkspaceOpen(false);
            setNewWorkspaceFolderId(null);
            if (folderId) {
              await placeNewWorkspaceInFolder(projectId, result, folderId);
            }
          }
          return !!result;
        }}
      />

      <NewFolderDialog
        open={newFolderOpen}
        onOpenChange={(open) => {
          setNewFolderOpen(open);
          if (!open) {
            setPendingMovePath(null);
            setNewFolderParentId(null);
          }
        }}
        onConfirm={async (name) => {
          setNewFolderOpen(false);
          const movePath = pendingMovePath;
          const parentId = newFolderParentId;
          setPendingMovePath(null);
          setNewFolderParentId(null);
          await createWorkspaceFolder(
            projectId,
            name,
            movePath ?? undefined,
            parentId,
          );
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
