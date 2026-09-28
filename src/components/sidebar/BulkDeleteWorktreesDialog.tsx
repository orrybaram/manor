import * as Dialog from "@radix-ui/react-dialog";
import type { WorkspaceInfo } from "../../store/project-store";
import styles from "./dialogs.module.css";
import { Button } from "../ui/Button/Button";
import { useDeleteBranchPreference } from "./useDeleteBranchPreference";

type BulkDeleteWorktreesDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaces: WorkspaceInfo[];
  onConfirm: (workspaces: WorkspaceInfo[], deleteBranch: boolean) => void;
};

/**
 * Bulk sibling of `DeleteWorktreeDialog` (ADR-190 §2): lists every workspace
 * about to go instead of naming one, but shares the same "also delete local
 * branches" checkbox (`useDeleteBranchPreference`), so the choice made in
 * one dialog carries over to the other.
 */
export function BulkDeleteWorktreesDialog(props: BulkDeleteWorktreesDialogProps) {
  const { open, onOpenChange, workspaces, onConfirm } = props;

  const [deleteBranchChecked, setDeleteBranchChecked] =
    useDeleteBranchPreference();

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.confirmOverlay} />
        <Dialog.Content className={styles.confirmDialog}>
          <Dialog.Title className={styles.confirmTitle}>
            Delete {workspaces.length}{" "}
            {workspaces.length === 1 ? "Workspace" : "Workspaces"}
          </Dialog.Title>
          <Dialog.Description className={styles.confirmDescription}>
            This will remove {workspaces.length}{" "}
            {workspaces.length === 1 ? "worktree" : "worktrees"} from disk.
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
                onChange={(e) => setDeleteBranchChecked(e.target.checked)}
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
