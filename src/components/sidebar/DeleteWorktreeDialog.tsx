import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import GitBranch from "lucide-react/dist/esm/icons/git-branch";
import type { WorkspaceInfo } from "../../store/project-store";
import styles from "./Sidebar/Sidebar.module.css";
import { Button } from "../ui/Button/Button";

type DeleteWorktreeDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspace: WorkspaceInfo | null;
  onConfirm: (ws: WorkspaceInfo, deleteBranch: boolean) => void;
};

export function DeleteWorktreeDialog(props: DeleteWorktreeDialogProps) {
  const { open, onOpenChange, workspace, onConfirm } = props;

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
                Also delete local branch
              </label>
            </div>
          )}
          <div className={styles.confirmActions}>
            <Button
              variant="secondary"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                if (workspace) {
                  onOpenChange(false);
                  onConfirm(workspace, deleteBranchChecked);
                }
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
