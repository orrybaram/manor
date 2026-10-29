import * as ContextMenu from "@radix-ui/react-context-menu";
import Copy from "lucide-react/dist/esm/icons/copy";
import ExternalLink from "lucide-react/dist/esm/icons/external-link";
import FolderOpen from "lucide-react/dist/esm/icons/folder-open";
import Pencil from "lucide-react/dist/esm/icons/pencil";
import Trash2 from "lucide-react/dist/esm/icons/trash-2";
import { openInEditor } from "../../../../lib/editor";
import { getPlatform } from "../../../../lib/keybindings";
import { isWebApp } from "../../../../lib/platform";
import { LOCAL_HOST_ID } from "../../../../lib/workspace-key";
import type { FilesWorkspace } from "../open-file-watches";
import styles from "./FileDrawer.module.css";

/** The tree row a right-click landed on. */
export type MenuTarget = { kind: "file" | "dir"; path: string };

type TreeRowMenuProps = {
  workspace: FilesWorkspace;
  target: MenuTarget;
  /** Offer Rename and Delete. Not on the phone, which only reads. */
  canWrite: boolean;
  /** Why Rename is off for this file (the open file has unsaved edits), or null. */
  renameBlocked: string | null;
  onRename: (path: string) => void;
  onDelete: (path: string) => void;
  /** The menu has closed and given focus back: Rename's input can take it now. */
  onClosed: () => void;
};

const REVEAL_LABEL =
  getPlatform() === "mac" ? "Reveal in Finder" : "Show in Folder";

/**
 * The drawer tree's context menu for one row. Open in Editor and Reveal need
 * the file on this machine, so a remote host's workspace (and the phone) is
 * offered only the paths; Rename and Delete are files', not folders'.
 */
export function TreeRowMenu({
  workspace,
  target,
  canWrite,
  renameBlocked,
  onRename,
  onDelete,
  onClosed,
}: TreeRowMenuProps) {
  const absolute = `${workspace.path}/${target.path}`;
  const onThisMachine = !isWebApp() && workspace.hostId === LOCAL_HOST_ID;
  const editable = canWrite && target.kind === "file";

  return (
    <ContextMenu.Content
      className={styles.contextMenu}
      data-testid="file-pane-tree-menu"
      // Not back to the tree: Rename's input, mounting now, takes it.
      onCloseAutoFocus={(e) => {
        e.preventDefault();
        onClosed();
      }}
    >
      {onThisMachine && (
        <>
          <ContextMenu.Item
            className={styles.contextMenuItem}
            onSelect={() => openInEditor(absolute)}
          >
            <ExternalLink size={14} />
            Open in Editor
          </ContextMenu.Item>
          <ContextMenu.Item
            className={styles.contextMenuItem}
            onSelect={() =>
              void window.electronAPI.shell.showItemInFolder(absolute)
            }
          >
            <FolderOpen size={14} />
            {REVEAL_LABEL}
          </ContextMenu.Item>
          <ContextMenu.Separator className={styles.contextMenuSeparator} />
        </>
      )}
      <ContextMenu.Item
        className={styles.contextMenuItem}
        data-testid="file-pane-tree-copy-path"
        onSelect={() => void navigator.clipboard.writeText(absolute)}
      >
        <Copy size={14} />
        Copy Path
      </ContextMenu.Item>
      <ContextMenu.Item
        className={styles.contextMenuItem}
        data-testid="file-pane-tree-copy-relative-path"
        onSelect={() => void navigator.clipboard.writeText(target.path)}
      >
        <Copy size={14} />
        Copy Relative Path
      </ContextMenu.Item>
      {editable && (
        <>
          <ContextMenu.Separator className={styles.contextMenuSeparator} />
          <ContextMenu.Item
            className={styles.contextMenuItem}
            data-testid="file-pane-tree-rename"
            disabled={renameBlocked !== null}
            title={renameBlocked ?? undefined}
            onSelect={() => onRename(target.path)}
          >
            <Pencil size={14} />
            Rename…
          </ContextMenu.Item>
          <ContextMenu.Item
            className={`${styles.contextMenuItem} ${styles.contextMenuItemDanger}`}
            data-testid="file-pane-tree-delete"
            onSelect={() => onDelete(target.path)}
          >
            <Trash2 size={14} />
            Delete…
          </ContextMenu.Item>
        </>
      )}
    </ContextMenu.Content>
  );
}
