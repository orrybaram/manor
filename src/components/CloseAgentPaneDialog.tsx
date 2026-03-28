import * as Dialog from "@radix-ui/react-dialog";
import styles from "./Sidebar.module.css";

export function CloseAgentPaneDialog({
  open,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
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
            <button
              className={styles.confirmCancel}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </button>
            <button
              className={styles.confirmRemove}
              onClick={() => {
                onOpenChange(false);
                onConfirm();
              }}
            >
              Close
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
