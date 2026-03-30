import * as Dialog from "@radix-ui/react-dialog";
import GitBranch from "lucide-react/dist/esm/icons/git-branch";
import GitMerge from "lucide-react/dist/esm/icons/git-merge";
import Trash2 from "lucide-react/dist/esm/icons/trash-2";
import type { WorkspaceInfo } from "../../store/project-store";
import styles from "./Sidebar/Sidebar.module.css";
import { Button } from "../ui/Button/Button";

type MergeWorktreeDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspace: WorkspaceInfo | null;
  defaultBranch: string;
  onConfirm: (ws: WorkspaceInfo) => void;
};

export function MergeWorktreeDialog(props: MergeWorktreeDialogProps) {
  const { open, onOpenChange, workspace, defaultBranch, onConfirm } = props;

  const wsName = workspace?.name || workspace?.branch || "";

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.confirmOverlay} />
        <Dialog.Content className={styles.confirmDialog}>
          <Dialog.Title className={styles.confirmTitle}>
            Merge & Delete Workspace
          </Dialog.Title>
          <Dialog.Description className={styles.confirmDescription}>
            This will perform the following actions:
          </Dialog.Description>
          <div className={styles.mergeSteps}>
            <div className={styles.mergeStep}>
              <GitMerge size={14} />
              <span>
                Fast-forward merge{" "}
                <code className={styles.branchInline}>
                  {workspace?.branch || wsName}
                </code>{" "}
                into{" "}
                <code className={styles.branchInline}>{defaultBranch}</code>
              </span>
            </div>
            <div className={styles.mergeStep}>
              <Trash2 size={14} />
              <span>
                Remove the worktree from disk and delete local branch{" "}
                <code className={styles.branchInline}>
                  {workspace?.branch || wsName}
                </code>
              </span>
            </div>
          </div>
          {workspace?.branch && (
            <div className={styles.branchDeleteSection}>
              <code className={styles.branchName}>
                <GitBranch size={12} />
                {workspace.branch}
                {" → "}
                {defaultBranch}
              </code>
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
                  onConfirm(workspace);
                }
              }}
            >
              Merge & Delete
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
