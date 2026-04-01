import { useState, useEffect } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import GitBranch from "lucide-react/dist/esm/icons/git-branch";
import styles from "./Sidebar/Sidebar.module.css";
import { Button } from "../ui/Button/Button";
import { Input } from "../ui/Input/Input";

type ConvertToWorkspaceDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  branch: string;
  onConfirm: (name: string) => void;
};

export function ConvertToWorkspaceDialog(props: ConvertToWorkspaceDialogProps) {
  const { open, onOpenChange, branch, onConfirm } = props;

  const [name, setName] = useState(branch);

  useEffect(() => {
    if (open) {
      setName(branch);
    }
  }, [open, branch]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.confirmOverlay} />
        <Dialog.Content className={styles.confirmDialog}>
          <Dialog.Title className={styles.confirmTitle}>
            Convert to Workspace
          </Dialog.Title>
          <Dialog.Description className={styles.confirmDescription}>
            Move branch{" "}
            <code className={styles.branchInline}>{branch}</code>{" "}
            to a new workspace and reset local to the default branch.
          </Dialog.Description>
          {branch && (
            <div className={styles.branchDeleteSection}>
              <code className={styles.branchName}>
                <GitBranch size={12} />
                {branch}
              </code>
            </div>
          )}
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Workspace name"
          />
          <div className={styles.confirmActions}>
            <Button
              variant="secondary"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                if (name) {
                  onConfirm(name);
                }
              }}
            >
              Convert
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
