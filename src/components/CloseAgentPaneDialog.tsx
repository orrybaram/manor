import * as Dialog from "@radix-ui/react-dialog";
import styles from "./sidebar/dialogs.module.css";
import { Button } from "./ui/Button/Button";

type CloseAgentPaneDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
};

export function CloseAgentPaneDialog(props: CloseAgentPaneDialogProps) {
  const { open, onOpenChange, onConfirm } = props;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.confirmOverlay} />
        <Dialog.Content className={styles.confirmDialog}>
          <Dialog.Title className={styles.confirmTitle}>
            Close Pane
          </Dialog.Title>
          <Dialog.Description className={styles.confirmDescription}>
            An agent is currently running in this pane. Are you sure you want to
            close it?
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
              onClick={() => {
                onOpenChange(false);
                onConfirm();
              }}
            >
              Close
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
