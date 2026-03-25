import * as Dialog from "@radix-ui/react-dialog";
import styles from "./Sidebar.module.css";

export function RemoveProjectDialog({
  open,
  onOpenChange,
  projectName,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectName: string;
  onConfirm: () => void;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.confirmOverlay} />
        <Dialog.Content className={styles.confirmDialog}>
          <Dialog.Title className={styles.confirmTitle}>
            Remove Project
          </Dialog.Title>
          <Dialog.Description className={styles.confirmDescription}>
            Remove <strong>{projectName}</strong> from the sidebar? This won't
            delete any files on disk.
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
              Remove
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
