import * as Dialog from "@radix-ui/react-dialog";
import styles from "./sidebar/dialogs.module.css";
import { Button } from "./ui/Button/Button";

type CloseAgentPaneDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  /** A file pane being closed has unsaved edits to this file (its name). */
  unsavedFile?: string | null;
};

export function CloseAgentPaneDialog(props: CloseAgentPaneDialogProps) {
  const { open, onOpenChange, onConfirm, unsavedFile } = props;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.confirmOverlay} />
        <Dialog.Content className={styles.confirmDialog}>
          <Dialog.Title className={styles.confirmTitle}>
            Close Pane
          </Dialog.Title>
          <Dialog.Description className={styles.confirmDescription}>
            {unsavedFile ? (
              <>
                Unsaved changes to <b>{unsavedFile}</b> will be lost. Are you sure
                you want to close it?
              </>
            ) : (
              <>
                An agent is currently running in this pane. Are you sure you want to
                close it?
              </>
            )}
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
              {unsavedFile ? "Discard and close" : "Close"}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
