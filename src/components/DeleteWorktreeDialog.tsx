import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { GitBranch } from "lucide-react";
import type { WorkspaceInfo } from "../store/project-store";
import styles from "./Sidebar.module.css";

export function DeleteWorktreeDialog({
  open,
  onOpenChange,
  workspace,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspace: WorkspaceInfo | null;
  onConfirm: (ws: WorkspaceInfo, deleteBranch: boolean) => void;
}) {
  const [deleteBranchChecked, setDeleteBranchChecked] = useState(
    () => localStorage.getItem("manor:deleteBranchOnWorktreeRemove") === "true",
  );

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.confirmOverlay} />
        <Dialog.Content className={styles.confirmDialog}>
          <Dialog.Title className={styles.confirmTitle}>
            Delete Workspace
          </Dialog.Title>
          <Dialog.Description className={styles.confirmDescription}>
            Delete workspace{" "}
            <strong>{workspace?.name || workspace?.branch || ""}</strong>? This
            will remove the worktree from disk.
          </Dialog.Description>
          {workspace?.branch && (
            <div className={styles.branchDeleteSection}>
              <code className={styles.branchName}>
                <GitBranch size={12} />
                {workspace.branch}
              </code>
              <label className={styles.checkboxLabel}>
                <input
                  type="checkbox"
                  checked={deleteBranchChecked}
                  onChange={(e) => {
                    setDeleteBranchChecked(e.target.checked);
                    localStorage.setItem(
                      "manor:deleteBranchOnWorktreeRemove",
                      String(e.target.checked),
                    );
                  }}
                />
                Also delete local branch
              </label>
            </div>
          )}
          <div className={styles.confirmActions}>
            <button
              className={styles.confirmCancel}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </button>
            <button
              className={styles.confirmRemove}
              onClick={() => {
                if (workspace) {
                  onOpenChange(false);
                  onConfirm(workspace, deleteBranchChecked);
                }
              }}
            >
              Delete
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
