import * as Dialog from "@radix-ui/react-dialog";
import { useStatsStore } from "../../store/stats-store";
import { Button } from "../ui/Button/Button";
import dialogStyles from "../sidebar/dialogs.module.css";

interface ResetStatsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Confirm-then-wipe dialog for usage stats (ADR-168 §6). */
export function ResetStatsDialog(props: ResetStatsDialogProps) {
  const { open, onOpenChange } = props;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={dialogStyles.confirmOverlay} />
        <Dialog.Content className={dialogStyles.confirmDialog}>
          <Dialog.Title className={dialogStyles.confirmTitle}>
            Reset Stats
          </Dialog.Title>
          <Dialog.Description className={dialogStyles.confirmDescription}>
            This deletes every counter, streak and badge stored on this device.
            It cannot be undone.
          </Dialog.Description>
          <div className={dialogStyles.confirmActions}>
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                onOpenChange(false);
                void useStatsStore.getState().reset();
              }}
            >
              Reset Stats
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
