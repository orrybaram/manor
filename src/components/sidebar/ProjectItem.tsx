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
import Laptop from "lucide-react/dist/esm/icons/laptop";
import {
  collapsedFolderIdsOf,
  useProjectStore,
  type CreateWorktreeOptions,
  type ProjectInfo,
  type WorkspaceInfo,
} from "../../store/project-store";
import { useAppStore } from "../../store/app-store";
import {
  applyGroupDrop,
  buildSidebarItems,
  descendantWorkspaces,
  canLinkLocalFolder,
  linkChoices as buildLinkChoices,
  placeAfterFolder,
  placeInFolder,
  placeManyAfterFolders,
  placeManyInFolder,
  selectionBySection,
  selectionKey,
  selectionKeyForPath,
  visibleSelectionKeys,
  type DropTarget,
  type Row,
  type SectionSelection,
  type SelectionScope,
  type SidebarItem,
} from "../../utils/sidebar-items";
import {
  hideWorkspacesAndNavigate,
  removeWorktreesWithToast,
} from "../../store/workspace-actions";
import {
  EMPTY_SIDEBAR_SELECTION,
  useSidebarSelectionStore,
} from "../../store/sidebar-selection-store";
import { useDeletingWorkspacesStore } from "../../store/deleting-workspaces-store";
import { headerRefKey, useSidebarDrag } from "../../hooks/useSidebarDrag";
import { useProjectAgentStatus } from "../../hooks/useProjectAgentStatus";
import { projectColorStyle, useProjectHeaderRow } from "../../hooks/useProjectHeaderRow";
import { ProjectChevron } from "./ProjectChevron";
import { ProjectHeaderActions } from "./ProjectHeaderActions";
import { useWorkspaceAgentStatus } from "../../hooks/useWorkspaceAgentStatus";
import { toWorkspaceIndicator } from "../../lib/workspace-indicator";
import { WorkspaceIndicatorDot } from "./WorkspaceIndicatorDot";
import { HostIndicator } from "../hosts/HostIndicator";
import { isRemoteHost } from "../../lib/hosts";
import {
  remoteTargetForProject,
  workspaceDisplayName,
} from "../../lib/sidebar-rail";
import { normalizeHostId, workspaceKey } from "../../lib/workspace-key";
import { useHostStore } from "../../store/host-store";
import { NewWorkspaceDialog } from "./NewWorkspaceDialog/NewWorkspaceDialog";
import { PrPopover } from "./PrPopover";
import { RemoveProjectDialog } from "./RemoveProjectDialog";
import { DeleteWorktreeDialog } from "./DeleteWorktreeDialog";
import { BulkDeleteWorktreesDialog } from "./BulkDeleteWorktreesDialog";
import { WorkspaceBulkMenu } from "./WorkspaceBulkMenu";
import { MergeWorktreeDialog } from "./MergeWorktreeDialog";
import { ConvertToWorkspaceDialog } from "./ConvertToWorkspaceDialog";
import { NewFolderDialog } from "./NewFolderDialog";
import { FolderItem } from "./FolderItem";
import { openInEditor } from "../../lib/editor";
import { openExternal } from "../../lib/open-external";
import { isWebApp } from "../../lib/platform";
import { onUiRequest, type UiRequest } from "../../utils/ui-request";
import { handleSidebarRowKeyDown } from "../../lib/sidebar-row";
import {
  openContextMenuFromKeyboard,
} from "../../lib/keyboard-context-menu";
import { useEmojiAutocomplete } from "../ui/EmojiAutocomplete/useEmojiAutocomplete";
import { composeHandlers } from "../ui/EmojiAutocomplete/compose";
import { Button } from "../ui/Button/Button";
import { Collapse } from "../ui/Collapse/Collapse";
import styles from "./ProjectItem.module.css";
import { CountBadge } from "../ui/CountBadge/CountBadge";

interface WorkspaceItemProps {
  ws: WorkspaceInfo;
  /** The host of the workspace's project (ADR-191). */
  hostId: string;
  /** True for the workspace currently open — matched by path, never by index. */
  isActive: boolean;
  /** True when this row is part of the sidebar multi-select (ADR-190). */
  isSelected: boolean;
  isDragging: boolean;
  /** Another row of the live group drag: dimmed, not lifted (ADR-190 §3). */
  isGroupDragging: boolean;
  /** Size of the group this row is leading in a drag; badged when 2+. */
  dragGroupCount: number;
  isDeleting: boolean;
  isEditing: boolean;
  editValue: string;
  editRef: React.RefObject<HTMLInputElement | null>;
  displayName: string;
  /** Transform supplied by the sidebar drag while a drag is in flight. */
  dragStyle: React.CSSProperties | undefined;
  justDragged: React.RefObject<boolean>;
  itemRefCallback: (el: HTMLDivElement | null) => void;
  /** A click the drag didn't swallow; plain, Shift or Cmd/Ctrl (ADR-190 §1). */
  onRowClick: (e: React.MouseEvent) => void;
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
    hostId,
    isActive,
    isSelected,
    isDragging,
    isGroupDragging,
    dragGroupCount,
    isDeleting,
    isEditing,
    editValue,
    editRef,
    displayName,
    dragStyle,
    justDragged,
    itemRefCallback,
    onRowClick,
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

  const { status: workspaceStatus, pulse: workspacePulse } = useWorkspaceAgentStatus(
    workspaceKey(hostId, ws.path),
  );
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
      aria-selected={isSelected ? "true" : undefined}
      {...rest}
      className={`${styles.workspace} ${isActive
          ? styles.workspaceActive
          : ""
        } ${isSelected ? styles.workspaceSelected : ""} ${isDragging ? styles.workspaceDragging : ""} ${isGroupDragging ? styles.workspaceGroupDragging : ""} ${isDeleting ? styles.workspaceDeleting : ""}${rest.className ? ` ${rest.className}` : ""}`}
      style={{ ...dragStyle, ...rest.style }}
      onClick={(e) => {
        if (!justDragged.current) onRowClick(e);
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
                  hostId={hostId}
                  onOpen={() => openExternal(ws.pr!.url)}
                />
              )}
            </div>
          </div>
          {isDragging && dragGroupCount > 1 && (
            <CountBadge
              count={dragGroupCount}
              tone="accent"
              className={styles.dragCountBadge}
              data-testid="drag-count-badge"
              aria-hidden="true"
            />
          )}
        </>
      )}
    </div>
  );
});

/**
 * A host heading's label (ADR-193 §3): host icon and name. A remote host's
 * icon is `HostIndicator`'s, so it crosses out while away and opens the host
 * popover. The heading stays dim whatever the state: the crossed-out glyph
 * says enough without pulling the eye. Used by a linked group's section
 * headers and above a remote-only project's workspaces. A collapsed section
 * shows its workspace count after the name.
 */
function SectionHostLabel(props: {
  hostId: string;
  projectId: string;
  path: string;
  label: string;
  collapsedCount: number | null;
}) {
  const { hostId, projectId, path, label, collapsedCount } = props;
  const remote = isRemoteHost(hostId);

  return (
    <span
      className={styles.sectionHost}
      title={path}
    >
      {remote ? (
        <span className={styles.sectionHostIcon}>
          <HostIndicator hostId={hostId} variant="icon" projectId={projectId} />
        </span>
      ) : (
        <Laptop size={11} aria-hidden />
      )}
      <span className={styles.sectionHostName}>{label}</span>
      {collapsedCount !== null && (
        <CountBadge count={collapsedCount} size="xs" />
      )}
    </span>
  );
}

/**
 * `project`: a lone project's entry. `section`: one host's section of a
 * linked group (ADR-192).
 */
export type ProjectItemVariant = "project" | "section";

type ProjectItemProps = {
  project: ProjectInfo;
  isSelected: boolean;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onSelect: () => void;
  onRemove: () => void;
  onSelectWorkspace: (index: number) => void;
  /** Resolves to whether the worktree was removed. */
  onRemoveWorktree: (ws: WorkspaceInfo, deleteBranch: boolean) => Promise<boolean>;
  onRenameWorkspace: (ws: WorkspaceInfo, newName: string) => void;
  onHideWorkspace: (ws: WorkspaceInfo, idx: number) => void;
  onUnhideWorkspace: (ws: WorkspaceInfo) => void;
  /**
   * `projectId` is this project, or — for a linked project — the member the
   * New Workspace host picker chose (ADR-192).
   */
  onCreateWorktree: (
    projectId: string,
    name: string,
    branch: string,
    options: Pick<
      CreateWorktreeOptions,
      "baseBranch" | "useExistingBranch" | "agentPrompt" | "folderId"
    >,
  ) => Promise<string | null>;
  onOpenSettings?: () => void;
  onDragStart?: (e: ReactPointerEvent) => void;
  /** Turns off the workspace/folder reorder drag inside this project. */
  dragDisabled?: boolean;
  onQuickMergeWorktree?: (ws: WorkspaceInfo) => void;
  onOpenDiff?: (wsIndex: number) => void;
  /**
   * `section`: this project is one host's section of a linked group
   * (ADR-192). Its header shows the host rather than the project, and the
   * group row above it carries the name, color and drag.
   */
  variant?: ProjectItemVariant;
  /**
   * The selection this project's rows share. A section passes its group's,
   * so ranges, toggles and bulk actions span the group's host sections
   * (ADR-192 ticket 7); absent, the project is a scope of its own.
   */
  selectionScope?: SelectionScope;
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
    dragDisabled = false,
    onQuickMergeWorktree,
    onOpenDiff,
    variant = "project",
    selectionScope,
  } = props;

  const isSection = variant === "section";

  const expanded = !collapsed;
  // A remote project's main workspace is named for its box, not "local".
  const remoteTarget = useHostStore((state) =>
    remoteTargetForProject(project, state),
  );
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
  // Set when "New Folder…" is picked from a workspace's (or a selection's)
  // menu: the folder is created and those workspaces moved into it in one
  // step. A single row is still an array of one (ADR-190 §2).
  const [pendingMovePaths, setPendingMovePaths] = useState<string[] | null>(null);
  // By section: a group-wide selection deletes each workspace through its own
  // member project (ADR-192 ticket 7).
  const [confirmBulkDelete, setConfirmBulkDelete] =
    useState<SectionSelection[] | null>(null);
  // The folder the next new folder belongs in: a folder's "New Folder Inside…",
  // or the folder the "New Folder…" anchor already lives in, so the new group
  // appears where it was asked for rather than at the top level (ADR-172).
  const [newFolderParentId, setNewFolderParentId] = useState<string | null>(null);
  // A folder's inline rename input, like a workspace's, suspends dragging.
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null);

  // Rows being removed stay dimmed until they are gone — shared, since a
  // bulk delete from another section of this group may be removing them.
  const deletingKeys = useDeletingWorkspacesStore((s) => s.keys);

  const [mergeState, setMergeState] = useState<{
    canMerge: boolean;
    reason?: string;
  } | null>(null);
  const editRef = useRef<HTMLInputElement>(null);
  // Paths of workspace rows whose context menu was opened via the keyboard
  // (`openMenu`), so `onCloseAutoFocus` knows to return focus to the row; a
  // mouse-opened menu keeps Radix's own default (ADR-175).
  const workspaceMenuOpenedByKeyboard = useRef<Set<string>>(new Set());
  // The header's keyboard, and its menu's return of focus (shared with the
  // linked-group header, ADR-192).
  const projectHeader = useProjectHeaderRow(collapsed, onToggleCollapsed);

  const collapsedFolderKeys = useProjectStore((s) => s.collapsedFolderKeys);
  const toggleFolderCollapsed = useProjectStore((s) => s.toggleFolderCollapsed);
  const createWorkspaceFolder = useProjectStore((s) => s.createWorkspaceFolder);
  const renameWorkspaceFolder = useProjectStore((s) => s.renameWorkspaceFolder);
  const deleteWorkspaceFolder = useProjectStore((s) => s.deleteWorkspaceFolder);
  const applySidebarChange = useProjectStore((s) => s.applySidebarChange);
  const allProjects = useProjectStore((s) => s.projects);
  // The New Workspace dialog offers every member of a linked group, so its
  // host picker can create on another host (ADR-192).
  const dialogProjects = useMemo(() => {
    const memberIds = project.group?.memberIds;
    if (!memberIds) return [project];
    const members = allProjects.filter((p) => memberIds.includes(p.id));
    return members.some((p) => p.id === project.id) ? members : [project];
  }, [project, allProjects]);
  const linkProjects = useProjectStore((s) => s.linkProjects);
  const linkLocalFolder = useProjectStore((s) => s.linkLocalFolder);
  const unlinkProject = useProjectStore((s) => s.unlinkProject);
  const linkChoices = useMemo(
    () => buildLinkChoices(project, allProjects),
    [project, allProjects],
  );
  const localFolderEligible = useMemo(
    () => canLinkLocalFolder(project, allProjects),
    [project, allProjects],
  );

  const { status: projectStatus, pulse: projectPulse } = useProjectAgentStatus(project);
  const projectIndicator = toWorkspaceIndicator(projectStatus, projectPulse);
  const mainWorkspace = project.workspaces.find((ws) => ws.isMain);
  const hiddenWorkspaces = project.workspaces.filter((ws) => ws.hidden);

  const { id: projectId, workspaces, folders, sidebarOrder } = project;
  const items = useMemo(
    () => buildSidebarItems({ workspaces, folders, sidebarOrder }),
    [workspaces, folders, sidebarOrder],
  );
  const collapsedFolderIds = useMemo(
    () => collapsedFolderIdsOf({ id: projectId, folders }, collapsedFolderKeys),
    [folders, collapsedFolderKeys, projectId],
  );
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
  // A path can be on two hosts (ADR-191): only the active host's section
  // holds the active workspace. While the Tasks view is shown (ADR-198) no
  // workspace row is the current one.
  const onActiveHost = useAppStore(
    (s) =>
      s.activeSurface === "workspace" &&
      s.activeWorkspaceHostId === normalizeHostId(project.hostId),
  );
  // Keyed by path, not by `selectedWorkspaceIndex`: that index addresses an
  // array the sidebar re-sorts on every reorder, so it drifts onto whichever
  // workspace now sits at the old position. A folder tinting itself accent
  // because a stale index landed inside it is the bug that made the highlight
  // look random. The active path is the thing the user is actually looking at.
  const selectedWorkspace = onActiveHost
    ? project.workspaces.find((ws) => ws.path === activeWorkspacePath)
    : undefined;

  // What this project's selection is shared across: its group's host
  // sections when it is one (ADR-192 ticket 7), else just itself.
  const scope = useMemo<SelectionScope>(
    () =>
      selectionScope ?? {
        id: projectId,
        sections: [{ project, items, collapsedFolderIds, collapsed: false }],
      },
    [selectionScope, projectId, project, items, collapsedFolderIds],
  );
  // Tree order of every workspace a shift-click range can land on, across the
  // scope's sections — a collapsed folder's members are off screen and out of
  // the range, exactly as they are absent from `flattenRows` (ADR-190 §1).
  const orderedVisibleKeys = useMemo(
    () => visibleSelectionKeys(scope.sections),
    [scope],
  );
  // Read only when the selection belongs to this scope: a selection made in
  // another project highlights nothing here. `selectionBySection` drops keys
  // whose row has since left the sidebar (deleted, or hidden from anywhere).
  const storedKeys = useSidebarSelectionStore((s) =>
    s.scopeId === scope.id ? s.keys : EMPTY_SIDEBAR_SELECTION,
  );
  // The selection split by owning member project, each in tree order
  // (ADR-190 §2): visible rows first, then any a collapsed folder hides — the
  // same rule the group drag uses to order its own block.
  const selectionSections = useMemo(
    () => selectionBySection(scope.sections, storedKeys),
    [scope, storedKeys],
  );
  const allSelected = useMemo(
    () => selectionSections.flatMap((s) => s.workspaces),
    [selectionSections],
  );
  // This project's own share: what it highlights, drags and files in folders.
  const orderedSelection = useMemo(
    () =>
      selectionSections
        .find((s) => s.section.project.id === projectId)
        ?.workspaces.map((ws) => ws.path) ?? [],
    [selectionSections, projectId],
  );
  const selectedPaths = useMemo(() => new Set(orderedSelection), [orderedSelection]);
  const firstSelectedFolderId =
    workspaces.find((ws) => ws.path === orderedSelection[0])?.folderId ?? null;
  // Folders belong to one member project, so a selection spanning host
  // sections has no folder its rows could all move into.
  const selectionSpansSections = selectionSections.length > 1;

  const handleDrop = useCallback(
    (
      sourceKey: string,
      target: DropTarget,
      rows: Row[],
      groupKeys: string[] | undefined,
    ) => {
      // A group of one (or none) is exactly `applyDrop` (ADR-190 §3).
      applySidebarChange(
        projectId,
        applyGroupDrop(items, sourceKey, groupKeys ?? [sourceKey], target, rows),
      );
      // The group has landed where the user put it; the selection has done
      // its job.
      if (groupKeys && groupKeys.length > 1) {
        useSidebarSelectionStore.getState().clear();
      }
    },
    [applySidebarChange, projectId, items],
  );

  const {
    dragKey,
    dragGroupKeys,
    intoFolderId,
    justDragged,
    rowRefs,
    handleDragStart,
    getTransformStyle,
  } = useSidebarDrag({
    items,
    collapsedFolderIds,
    disabled: dragDisabled || editingPath !== null || editingFolderId !== null,
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
    const displayName = workspaceDisplayName(ws, remoteTarget);
    const rowKey = selectionKey(projectId, ws.path);
    const isDeleting = deletingKeys.has(rowKey);

    const workspaceEl = (
      <WorkspaceItem
        ws={ws}
        hostId={project.hostId}
        isActive={onActiveHost && ws.path === activeWorkspacePath}
        isSelected={selectedPaths.has(ws.path)}
        isDragging={dragKey === ws.path}
        isGroupDragging={
          dragKey !== ws.path && (dragGroupKeys?.includes(ws.path) ?? false)
        }
        dragGroupCount={dragGroupKeys?.length ?? 0}
        isDeleting={isDeleting}
        isEditing={isEditing}
        editValue={editValue}
        editRef={editRef}
        displayName={displayName}
        dragStyle={getTransformStyle(ws.path)}
        justDragged={justDragged}
        itemRefCallback={registerRow(ws.path)}
        onRowClick={(e) => {
          const selection = useSidebarSelectionStore.getState();
          // The active path's key belongs to the project that has it open
          // (`selectWorkspace` moves `selectedProjectIndex` with it); this
          // section stands in only when that project is outside the scope.
          const activeKey = () => {
            const { projects, selectedProjectIndex } = useProjectStore.getState();
            return selectionKeyForPath(scope.sections, activeWorkspacePath, [
              projects[selectedProjectIndex]?.id,
              projectId,
            ]);
          };
          if (e.shiftKey) {
            // Modifier clicks select; they never navigate (ADR-190 §1).
            selection.selectRange(
              scope.id,
              orderedVisibleKeys,
              rowKey,
              activeKey(),
            );
          } else if (e.metaKey || e.ctrlKey) {
            selection.toggle(scope.id, rowKey, activeKey());
          } else {
            selection.setAnchor(scope.id, rowKey);
            onSelectWorkspace(globalIdx);
          }
        }}
        onRowKeyDown={(e) => {
          if (isEditing) return;
          // Escape clears the selection before handing off to the shared
          // handler's own Escape (which blurs the row and refocuses the
          // active pane) — both happen on one press (ADR-190 §1).
          if (e.key === "Escape") useSidebarSelectionStore.getState().clear();
          handleSidebarRowKeyDown(e, {
            activate: () => onSelectWorkspace(globalIdx),
            startRename: () => startRename(ws),
            openMenu: (row) => {
              workspaceMenuOpenedByKeyboard.current.add(ws.path);
              openContextMenuFromKeyboard(row);
            },
          });
        }}
        onPointerDown={(e) => {
          // Shift/Cmd/Ctrl-pointerdown are selection gestures, not drags
          // (ADR-190 §1); shift's browser text-selection needs an explicit
          // preventDefault since a click on plain text still fires from here.
          if (e.shiftKey) {
            e.preventDefault();
            return;
          }
          if (e.metaKey || e.ctrlKey) return;
          // Grabbing a row of a 2+ selection drags the whole selection, in
          // tree order (ADR-190 §3) — this project's share of it only, since
          // a drag never moves a workspace to another member project.
          const groupKeys =
            selectedPaths.has(ws.path) && orderedSelection.length > 1
              ? orderedSelection
              : undefined;
          handleDragStart(ws.path, "workspace", e, groupKeys);
        }}
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

    // A right-click on a row that is already part of a 2+ selection acts on
    // the whole selection; anything else clears it and falls back to the
    // single-workspace menu (ADR-190 §2).
    const isBulkSelected = selectedPaths.has(ws.path) && allSelected.length > 1;

    const closeAutoFocus = (e: Event) => {
      if (workspaceMenuOpenedByKeyboard.current.has(ws.path)) {
        e.preventDefault();
        rowRefs.current.get(ws.path)?.focus();
      }
      workspaceMenuOpenedByKeyboard.current.delete(ws.path);
    };

    return (
      <ContextMenu.Root
        key={ws.path}
        onOpenChange={(open) => {
          if (!open) {
            setMergeState(null);
            return;
          }
          if (!selectedPaths.has(ws.path)) {
            useSidebarSelectionStore.getState().clear();
          }
          if (!ws.isMain && !isBulkSelected) {
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
          {isBulkSelected ? (
            <WorkspaceBulkMenu
              selectedCount={allSelected.length}
              folderChoices={folderChoices}
              canMoveToFolder={!selectionSpansSections}
              hasFolderMember={allSelected.some((w) => w.folderId)}
              removableCount={allSelected.filter((w) => !w.isMain).length}
              onCloseAutoFocus={closeAutoFocus}
              onMoveToFolder={(folderId) => {
                applySidebarChange(
                  projectId,
                  placeManyInFolder(items, orderedSelection, folderId),
                );
                useSidebarSelectionStore.getState().clear();
              }}
              onNewFolder={() => {
                setPendingMovePaths(orderedSelection);
                setNewFolderParentId(firstSelectedFolderId);
                setNewFolderOpen(true);
              }}
              onRemoveFromFolder={() => {
                // Each member project's rows leave their own folders.
                for (const { section, workspaces: picked } of selectionSections) {
                  applySidebarChange(
                    section.project.id,
                    placeManyAfterFolders(
                      section.items,
                      picked.map((w) => w.path),
                    ),
                  );
                }
                useSidebarSelectionStore.getState().clear();
              }}
              onHide={() => {
                // Main can't be hidden; each member hides its own rows.
                for (const { section, workspaces: picked } of selectionSections) {
                  void hideWorkspacesAndNavigate(
                    section.project.id,
                    picked.map((w) => w.path),
                  );
                }
                useSidebarSelectionStore.getState().clear();
              }}
              onDelete={() => {
                setConfirmBulkDelete(
                  selectionSections
                    .map((s) => ({
                      section: s.section,
                      workspaces: s.workspaces.filter((w) => !w.isMain),
                    }))
                    .filter((s) => s.workspaces.length > 0),
                );
              }}
            />
          ) : (
          <ContextMenu.Content
            className={styles.contextMenu}
            onCloseAutoFocus={closeAutoFocus}
          >
            {/* `shell.*` has no browser meaning (ADR-178) — removed, not
                disabled, following the same rule for an affordance
                a paired device can't use at all. */}
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
                      setPendingMovePaths([ws.path]);
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
          )}
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
        hostId={project.hostId}
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
          setPendingMovePaths(null);
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

  const workspaceList = (
    <div className={styles.workspaces}>
      {items.map((item) => renderItem(item, 0))}
    </div>
  );

  return (
    <div
      className={
        isSection
          ? styles.section
          : `${styles.project} ${isSelected ? styles.projectSelected : ""}`
      }
      style={projectColorStyle(project.color)}
    >
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>
          <div
            ref={projectHeader.headerRef}
            data-testid={isSection ? "group-section-header" : "project-header"}
            data-sidebar-row=""
            tabIndex={-1}
            aria-expanded={expanded}
            className={`${styles.projectHeader} ${isSection ? styles.sectionHeader : ""}`}
            onClick={() => {
              onToggleCollapsed();
            }}
            onKeyDown={projectHeader.onKeyDown}
            onPointerDown={isSection ? undefined : onDragStart}
            style={{ touchAction: "none" }}
          >
            {!isSection && <ProjectChevron expanded={expanded} />}
            {!isSection && <span className={styles.projectSwatch} aria-hidden="true" />}
            {isSection ? (
              <SectionHostLabel
                hostId={project.hostId}
                projectId={project.id}
                path={project.path}
                label={isRemoteHost(project.hostId) ? remoteTarget ?? project.hostId : "This machine"}
                collapsedCount={expanded ? null : project.workspaces.length}
              />
            ) : (
            <span
              className={styles.projectName}
              title={project.path}
            >
              {project.name}
            </span>
            )}
            {collapsed && projectIndicator && (
              <WorkspaceIndicatorDot indicator={projectIndicator} />
            )}
            {!isSection && (
              <ProjectHeaderActions
                onNewWorkspace={() => setNewWorkspaceOpen(true)}
                onNewFolder={() => {
                  setPendingMovePaths(null);
                  setNewFolderParentId(null);
                  setNewFolderOpen(true);
                }}
                onOpenSettings={onOpenSettings}
              />
            )}
          </div>
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content
            className={styles.contextMenu}
            onCloseAutoFocus={projectHeader.onCloseAutoFocus}
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
                setPendingMovePaths(null);
                setNewFolderParentId(null);
                setNewFolderOpen(true);
              }}
            >
              New Folder
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
                  Hidden
                  <CountBadge count={hiddenWorkspaces.length} style={{ marginLeft: 6 }} />
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
            {/* A host section's menu covers only that host's workspaces;
                linking and removal live on the group header. */}
            {!isSection && (
              <>
                <ContextMenu.Separator className={styles.contextMenuSeparator} />
                <ContextMenu.Sub>
                  <ContextMenu.SubTrigger
                    className={styles.contextMenuItem}
                    style={{ display: "flex", alignItems: "center" }}
                    disabled={linkChoices.length === 0 && !localFolderEligible}
                  >
                    Link with…
                    <ChevronRight size={14} style={{ marginLeft: "auto" }} />
                  </ContextMenu.SubTrigger>
                  <ContextMenu.Portal>
                    <ContextMenu.SubContent
                      className={styles.contextMenu}
                      style={{ maxWidth: 260 }}
                    >
                      {linkChoices.map((choice) => (
                        <ContextMenu.Item
                          key={choice.key}
                          className={styles.contextMenuItem}
                          style={{ display: "flex", alignItems: "center", gap: 6 }}
                          onSelect={() => void linkProjects(project.id, choice.targetId)}
                        >
                          {choice.label}
                          {choice.hostIds.filter(isRemoteHost).map((hostId) => (
                            <HostIndicator key={hostId} hostId={hostId} variant="icon" />
                          ))}
                        </ContextMenu.Item>
                      ))}
                      {localFolderEligible && (
                        <>
                          {linkChoices.length > 0 && (
                            <ContextMenu.Separator className={styles.contextMenuSeparator} />
                          )}
                          <ContextMenu.Item
                            className={styles.contextMenuItem}
                            onSelect={() => void linkLocalFolder(project.id)}
                          >
                            Choose local folder…
                          </ContextMenu.Item>
                        </>
                      )}
                    </ContextMenu.SubContent>
                  </ContextMenu.Portal>
                </ContextMenu.Sub>
                {project.group && (
                  <ContextMenu.Item
                    className={styles.contextMenuItem}
                    onSelect={() => void unlinkProject(project.id)}
                  >
                    Unlink
                  </ContextMenu.Item>
                )}
                <ContextMenu.Separator className={styles.contextMenuSeparator} />
                <ContextMenu.Item
                  className={`${styles.contextMenuItem} ${styles.contextMenuItemDanger}`}
                  onSelect={() => setConfirmRemove(true)}
                >
                  Remove Project
                </ContextMenu.Item>
              </>
            )}
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>
      {isSection ? (
        <Collapse open={expanded && items.length > 0}>{workspaceList}</Collapse>
      ) : (
        <Collapse open={expanded && (isRemoteHost(project.hostId) || items.length > 0)}>
          {/* Hangs off a guide line under the chevron (ADR-193 §3). */}
          <div className={styles.projectBody}>
            {/* A remote-only project names its host above its workspaces,
                the way a linked group's sections do. */}
            {isRemoteHost(project.hostId) && (
              <div className={styles.hostHeading} data-testid="project-host-heading">
                <SectionHostLabel
                  hostId={project.hostId}
                  projectId={project.id}
                  path={project.path}
                  label={remoteTarget ?? project.hostId}
                  collapsedCount={null}
                />
              </div>
            )}
            {items.length > 0 && workspaceList}
          </div>
        </Collapse>
      )}

      <NewWorkspaceDialog
        open={newWorkspaceOpen}
        onClose={() => {
          setNewWorkspaceOpen(false);
          setNewWorkspaceFolderId(null);
        }}
        projects={dialogProjects}
        selectedProjectIndex={0}
        preselectedProjectId={project.id}
        // Opened from this host's own section or folder: start there.
        preferredMemberId={isSection ? project.id : null}
        initialFolderId={newWorkspaceFolderId}
        onSubmit={async (createInId, name, branch, baseBranch, useExistingBranch, folderId, agentPrompt) => {
          const result = await onCreateWorktree(createInId, name, branch, {
            baseBranch,
            useExistingBranch,
            agentPrompt,
            folderId,
          });
          if (result) {
            setNewWorkspaceOpen(false);
            setNewWorkspaceFolderId(null);
          }
          return !!result;
        }}
      />

      <NewFolderDialog
        open={newFolderOpen}
        onOpenChange={(open) => {
          setNewFolderOpen(open);
          if (!open) {
            setPendingMovePaths(null);
            setNewFolderParentId(null);
          }
        }}
        // Moving rows or nesting in a folder ties the new folder to this
        // host; a bare "New Folder" can go on any of the group's hosts.
        hostChoices={(pendingMovePaths || newFolderParentId ? [project] : dialogProjects).map(
          (p) => ({ projectId: p.id, hostId: p.hostId, disabledReason: null }),
        )}
        initialProjectId={project.id}
        onConfirm={async (name, chosenId) => {
          setNewFolderOpen(false);
          const movePaths = pendingMovePaths;
          const parentId = newFolderParentId;
          setPendingMovePaths(null);
          setNewFolderParentId(null);
          await createWorkspaceFolder(
            chosenId ?? projectId,
            name,
            movePaths ?? undefined,
            parentId,
          );
          if (movePaths && movePaths.length > 1) {
            useSidebarSelectionStore.getState().clear();
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
          const key = selectionKey(projectId, ws.path);
          const deleting = useDeletingWorkspacesStore.getState();
          deleting.mark([key]);
          void onRemoveWorktree(ws, deleteBranch).then(() =>
            deleting.unmark([key]),
          );
        }}
      />

      <BulkDeleteWorktreesDialog
        open={confirmBulkDelete !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmBulkDelete(null);
        }}
        workspaces={
          confirmBulkDelete?.flatMap(({ section, workspaces: targets }) =>
            targets.map((ws) => ({ projectId: section.project.id, ws })),
          ) ?? []
        }
        onConfirm={(_workspaces, deleteBranch) => {
          // State, not `_workspaces`: the sections already hold each row's
          // owning project, grouped the way the removals must run.
          const bySection = confirmBulkDelete ?? [];
          useSidebarSelectionStore.getState().clear();
          const deleting = useDeletingWorkspacesStore.getState();
          const current = useProjectStore.getState().projects;
          // Each member project removes its own worktrees on its own host.
          // They are separate repos, so only one project's removals queue up
          // behind each other (ADR-192 ticket 7).
          for (const { section, workspaces: targets } of bySection) {
            const owner =
              current.find((p) => p.id === section.project.id) ?? section.project;
            const keys = targets.map((w) => selectionKey(owner.id, w.path));
            deleting.mark(keys);
            void removeWorktreesWithToast(owner, targets, deleteBranch).then(() =>
              deleting.unmark(keys),
            );
          }
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
