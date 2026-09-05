import { useRef, useState } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import Folder from "lucide-react/dist/esm/icons/folder";
import type { WorkspaceFolder, WorkspaceInfo } from "../../store/project-store";
import { useWorkspacesAgentStatus } from "../../hooks/useProjectAgentStatus";
import { AgentDot } from "../ui/AgentDot/AgentDot";
import styles from "./ProjectItem.module.css";

type FolderItemProps = {
  folder: WorkspaceFolder;
  /** Visible members, used for the count and the collapsed agent dot. */
  workspaces: WorkspaceInfo[];
  collapsed: boolean;
  /** True when the project's selected workspace lives in this folder. */
  containsSelected: boolean;
  /** True while a dragged workspace hovers this header: drop-into highlight. */
  dropTarget: boolean;
  /** True while this folder's own block is the thing being dragged. */
  isDragging: boolean;
  onToggleCollapsed: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
  onDragStart: (e: React.PointerEvent) => void;
  /** Measured for folder drags (the whole block is one row). */
  registerBlock: (el: HTMLElement | null) => void;
  /** Measured for workspace drags (the header alone is the row). */
  registerHeader: (el: HTMLElement | null) => void;
  /** Transform for the block, set while a folder drag shifts it. */
  style?: React.CSSProperties;
  /** Transform for the header alone, set while a workspace drag shifts it. */
  headerStyle?: React.CSSProperties;
  /** True for one frame after a drag, so the release doesn't toggle collapse. */
  justDragged: React.RefObject<boolean>;
  /** Lets the parent suspend dragging while this folder is being renamed. */
  onEditingChange: (editing: boolean) => void;
  /** The member rows for this folder; rendered when expanded. */
  children: React.ReactNode;
};

/**
 * A folder header row plus its (optionally collapsed) body. Folders are
 * purely presentational groupings — deleting one only ungroups its members.
 */
export function FolderItem(props: FolderItemProps) {
  const {
    folder,
    workspaces,
    collapsed,
    containsSelected,
    dropTarget,
    isDragging,
    onToggleCollapsed,
    onRename,
    onDelete,
    onDragStart,
    registerBlock,
    registerHeader,
    style,
    headerStyle,
    justDragged,
    onEditingChange,
    children,
  } = props;

  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(folder.name);
  const editRef = useRef<HTMLInputElement>(null);

  const { status, pulse } = useWorkspacesAgentStatus(workspaces);

  const setEditingState = (next: boolean) => {
    setEditing(next);
    onEditingChange(next);
  };

  const startRename = () => {
    setEditValue(folder.name);
    setEditingState(true);
    requestAnimationFrame(() => {
      editRef.current?.focus();
      editRef.current?.select();
    });
  };

  const commitRename = () => {
    if (!editing) return;
    setEditingState(false);
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== folder.name) onRename(trimmed);
  };

  return (
    <div
      ref={registerBlock}
      className={`${styles.folder} ${isDragging ? styles.folderDragging : ""}`}
      style={style}
    >
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>
          <div
            ref={registerHeader}
            className={`${styles.folderHeader} ${containsSelected && collapsed ? styles.folderActive : ""} ${dropTarget ? styles.folderDropTarget : ""}`}
            style={{ touchAction: "none", ...headerStyle }}
            onClick={() => {
              if (!justDragged.current && !editing) onToggleCollapsed();
            }}
            onDoubleClick={(e) => {
              e.stopPropagation();
              startRename();
            }}
            onPointerDown={onDragStart}
          >
            <span
              className={`${styles.folderChevron} ${collapsed ? "" : styles.folderChevronOpen}`}
            >
              <ChevronRight size={12} />
            </span>
            <span className={styles.folderIcon}>
              <Folder size={12} />
            </span>
            {editing ? (
              <input
                ref={editRef}
                className={styles.workspaceNameInput}
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRename();
                  if (e.key === "Escape") {
                    setEditingState(false);
                    e.currentTarget.blur();
                  }
                }}
                onClick={(e) => e.stopPropagation()}
                onPointerDown={(e) => e.stopPropagation()}
              />
            ) : (
              <>
                <span className={styles.folderName} title={folder.name}>
                  {folder.name}
                </span>
                <span className={styles.folderCount}>{workspaces.length}</span>
                {collapsed && status && (
                  <AgentDot status={status} size="sidebar" pulse={pulse} />
                )}
              </>
            )}
          </div>
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content className={styles.contextMenu}>
            <ContextMenu.Item
              className={styles.contextMenuItem}
              onSelect={() => startRename()}
            >
              Rename Folder
            </ContextMenu.Item>
            <ContextMenu.Separator className={styles.contextMenuSeparator} />
            <ContextMenu.Item
              className={`${styles.contextMenuItem} ${styles.contextMenuItemDanger}`}
              onSelect={() => onDelete()}
            >
              Delete Folder
            </ContextMenu.Item>
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>
      {!collapsed && children && (
        <div className={styles.folderBody}>{children}</div>
      )}
    </div>
  );
}
