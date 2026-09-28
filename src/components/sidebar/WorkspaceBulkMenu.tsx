import * as ContextMenu from "@radix-ui/react-context-menu";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import styles from "./ProjectItem.module.css";

type WorkspaceBulkMenuProps = {
  /** Rows in the selection, main included. */
  selectedCount: number;
  /** Folder choices for "Move to Folder", tree order (ADR-172). */
  folderChoices: { id: string; label: string }[];
  /**
   * False when the selection spans a linked group's host sections: folders
   * belong to one member project, so there is no folder every row could
   * move into (ADR-192 ticket 7).
   */
  canMoveToFolder: boolean;
  /** True when any selected workspace sits in a folder. */
  hasFolderMember: boolean;
  /** Selection size excluding main, which can't be hidden or deleted; 0 hides both items. */
  removableCount: number;
  onMoveToFolder: (folderId: string) => void;
  onNewFolder: () => void;
  onRemoveFromFolder: () => void;
  onHide: () => void;
  onDelete: () => void;
  onCloseAutoFocus?: (e: Event) => void;
};

/**
 * The context menu for a 2+ workspace selection (ADR-190 §2). Split out of
 * `ProjectItem.tsx` — already the single-workspace menu's home — so that file
 * doesn't grow a second one inline. Reuses `ProjectItem.module.css`'s
 * context-menu classes so the two menus look identical.
 */
export function WorkspaceBulkMenu(props: WorkspaceBulkMenuProps) {
  const {
    selectedCount,
    folderChoices,
    canMoveToFolder,
    hasFolderMember,
    removableCount,
    onMoveToFolder,
    onNewFolder,
    onRemoveFromFolder,
    onHide,
    onDelete,
    onCloseAutoFocus,
  } = props;
  const removableNoun = removableCount === 1 ? "Workspace" : "Workspaces";

  return (
    <ContextMenu.Content
      className={styles.contextMenu}
      onCloseAutoFocus={onCloseAutoFocus}
    >
      <ContextMenu.Item className={styles.contextMenuItem} disabled>
        {selectedCount} workspaces selected
      </ContextMenu.Item>
      {canMoveToFolder ? (
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
                  onSelect={() => onMoveToFolder(choice.id)}
                >
                  {choice.label}
                </ContextMenu.Item>
              ))}
              {folderChoices.length > 0 && (
                <ContextMenu.Separator className={styles.contextMenuSeparator} />
              )}
              <ContextMenu.Item
                className={styles.contextMenuItem}
                onSelect={onNewFolder}
              >
                New Folder…
              </ContextMenu.Item>
            </ContextMenu.SubContent>
          </ContextMenu.Portal>
        </ContextMenu.Sub>
      ) : (
        <ContextMenu.Item className={styles.contextMenuItem} disabled>
          Move to Folder
          <span className={styles.contextMenuItemHint}>
            Selection spans hosts
          </span>
        </ContextMenu.Item>
      )}
      {hasFolderMember && (
        <ContextMenu.Item
          className={styles.contextMenuItem}
          onSelect={onRemoveFromFolder}
        >
          Remove from Folder
        </ContextMenu.Item>
      )}
      <ContextMenu.Separator className={styles.contextMenuSeparator} />
      {removableCount > 0 && (
        <>
          <ContextMenu.Item className={styles.contextMenuItem} onSelect={onHide}>
            Hide {removableCount} {removableNoun}
          </ContextMenu.Item>
          <ContextMenu.Item
            className={`${styles.contextMenuItem} ${styles.contextMenuItemDanger}`}
            onSelect={onDelete}
          >
            Delete {removableCount} {removableNoun}…
          </ContextMenu.Item>
        </>
      )}
    </ContextMenu.Content>
  );
}
