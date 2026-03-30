import * as Dialog from "@radix-ui/react-dialog";
import styles from "./Sidebar/Sidebar.module.css";
import { Button } from "../ui/Button/Button";

type RemoveProjectDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectName: string;
  onConfirm: () => void;
};

export function RemoveProjectDialog(props: RemoveProjectDialogProps) {
  const { open, onOpenChange, projectName, onConfirm } = props;

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
              Remove
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
