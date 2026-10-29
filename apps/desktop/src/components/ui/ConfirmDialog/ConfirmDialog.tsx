import { useState, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Button } from "../Button/Button";
import { toast, wasReported } from "../../../toast";
import dialogStyles from "../../sidebar/dialogs.module.css";

type ConfirmDialogProps = {
  open: boolean;
  title: ReactNode;
  description: ReactNode;
  /** Label of the confirming action, e.g. "Switch host". */
  confirmLabel: string;
  cancelLabel?: string;
  /** `danger` for destructive actions; `primary` otherwise. */
  confirmVariant?: "primary" | "danger";
  /**
   * May return a promise: the dialog then waits, its confirm
   * button disabled, and stays open if it rejects — so it never closes on a
   * failure. Closing on success is still the caller's, through `open`.
   * Cancel stays live, so an answer that never comes can't trap the user.
   */
  onConfirm: () => void | Promise<void>;
  /** Called on Cancel, Escape and clicking outside. */
  onCancel: () => void;
};

/**
 * A non-blocking replacement for `window.confirm` — same look as the app's
 * other confirmation dialogs (RemoveProjectDialog, RelayConfirmDialog).
 */
export function ConfirmDialog(props: ConfirmDialogProps) {
  const {
    open,
    title,
    description,
    confirmLabel,
    cancelLabel = "Cancel",
    confirmVariant = "primary",
    onConfirm,
    onCancel,
  } = props;

  const [pending, setPending] = useState(false);

  const confirm = () => {
    const result = onConfirm();
    if (!result) return;
    setPending(true);
    result
      .catch((err: unknown) => {
        // The action usually reports its own failure; anything it didn't
        // still reaches the user.
        if (!wasReported(err)) {
          toast.error("Something went wrong", {
            id: "confirm-dialog",
            error: err,
          });
        }
      })
      .finally(() => setPending(false));
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={dialogStyles.confirmOverlay} />
        <Dialog.Content className={dialogStyles.confirmDialog}>
          <Dialog.Title className={dialogStyles.confirmTitle}>{title}</Dialog.Title>
          <Dialog.Description className={dialogStyles.confirmDescription}>
            {description}
          </Dialog.Description>
          <div className={dialogStyles.confirmActions}>
            <Button variant="secondary" onClick={onCancel}>
              {cancelLabel}
            </Button>
            <Button variant={confirmVariant} onClick={confirm} disabled={pending}>
              {confirmLabel}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
