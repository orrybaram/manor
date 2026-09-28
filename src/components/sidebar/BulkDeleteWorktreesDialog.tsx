import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import type { WorkspaceInfo } from "../../store/project-store";
import styles from "./dialogs.module.css";
import { Button } from "../ui/Button/Button";

type BulkDeleteWorktreesDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaces: WorkspaceInfo[];
  onConfirm: (workspaces: WorkspaceInfo[], deleteBranch: boolean) => void;
};

/**
 * Bulk sibling of `DeleteWorktreeDialog` (ADR-190 §2): lists every workspace
 * about to go instead of naming one, but shares the same "also delete local
 * branches" checkbox, backed by the same `localStorage` key, so the choice
 * made in one dialog carries over to the other.
 */
export function BulkDeleteWorktreesDialog(props: BulkDeleteWorktreesDialogProps) {
  const { open, onOpenChange, workspaces, onConfirm } = props;

  const [deleteBranchChecked, setDeleteBranchChecked] = useState(() => {
    try {
      return localStorage.getItem("manor:deleteBranchOnWorktreeRemove") === "true";
    } catch {
      return false;
    }
  });

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.confirmOverlay} />
        <Dialog.Content className={styles.confirmDialog}>
          <Dialog.Title className={styles.confirmTitle}>
            Delete {workspaces.length} Workspaces
          </Dialog.Title>
          <Dialog.Description className={styles.confirmDescription}>
            This will remove {workspaces.length} worktrees from disk.
          </Dialog.Description>
          <ul className={styles.bulkDeleteList}>
            {workspaces.map((ws) => (
              <li key={ws.path} className={styles.bulkDeleteItem}>
                <span className={styles.bulkDeleteName}>
                  {ws.name || ws.branch || ws.path.split("/").pop() || "workspace"}
                </span>
                {ws.branch && (
                  <code className={styles.branchInline}>{ws.branch}</code>
                )}
              </li>
            ))}
          </ul>
          <div className={styles.branchDeleteSection}>
            <label className={styles.checkboxLabel}>
              <input
                type="checkbox"
                checked={deleteBranchChecked}
                onChange={(e) => {
                  setDeleteBranchChecked(e.target.checked);
                  try {
                    localStorage.setItem(
                      "manor:deleteBranchOnWorktreeRemove",
                      String(e.target.checked),
                    );
                  } catch {
                    // ignore
                  }
                }}
              />
              Also delete local branches
            </label>
          </div>
          <div className={styles.confirmActions}>
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                onOpenChange(false);
                onConfirm(workspaces, deleteBranchChecked);
              }}
            >
              Delete
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
