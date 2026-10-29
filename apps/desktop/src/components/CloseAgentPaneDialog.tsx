import * as Dialog from "@radix-ui/react-dialog";
import styles from "./sidebar/dialogs.module.css";
import { Button } from "./ui/Button/Button";
import { UnsavedFiles } from "./unsaved-edits/UnsavedFiles";

type CloseAgentPaneDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  /** An agent is running in what is closing. */
  agentRunning: boolean;
  /** Files with unsaved edits in the file panes closing, workspace-relative. */
  unsavedFiles: readonly string[];
};

export function CloseAgentPaneDialog(props: CloseAgentPaneDialogProps) {
  const { open, onOpenChange, onConfirm, agentRunning, unsavedFiles } = props;
  const unsaved = unsavedFiles.length > 0;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.confirmOverlay} />
        <Dialog.Content className={styles.confirmDialog}>
          <Dialog.Title className={styles.confirmTitle}>
            Close Pane
          </Dialog.Title>
          <Dialog.Description asChild className={styles.confirmDescription}>
            <div data-testid="close-pane-description">
              {(agentRunning || !unsaved) && (
                <div>An agent is currently running in this pane.</div>
              )}
              <UnsavedFiles files={unsavedFiles} end=" will be lost." />
              <div>Are you sure you want to close it?</div>
            </div>
          </Dialog.Description>
          <div className={styles.confirmActions}>
            <Button
              variant="secondary"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              data-testid="close-pane-confirm"
              onClick={() => {
                onOpenChange(false);
                onConfirm();
              }}
            >
              {unsaved ? "Discard and close" : "Close"}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
