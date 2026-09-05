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
  onToggleCollapsed: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
  /** The `WorkspaceList` for this folder's members; rendered when expanded. */
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
    onToggleCollapsed,
    onRename,
    onDelete,
    children,
  } = props;

  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(folder.name);
  const editRef = useRef<HTMLInputElement>(null);

  const { status, pulse } = useWorkspacesAgentStatus(workspaces);

  const startRename = () => {
    setEditValue(folder.name);
    setEditing(true);
    requestAnimationFrame(() => {
      editRef.current?.focus();
      editRef.current?.select();
    });
  };

  const commitRename = () => {
    if (!editing) return;
    setEditing(false);
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== folder.name) onRename(trimmed);
  };

  return (
    <div className={styles.folder}>
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>
          <div
            className={`${styles.folderHeader} ${containsSelected && collapsed ? styles.folderActive : ""}`}
            onClick={() => {
              if (!editing) onToggleCollapsed();
            }}
            onDoubleClick={(e) => {
              e.stopPropagation();
              startRename();
            }}
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
                    setEditing(false);
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
