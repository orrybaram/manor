import type { ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Button } from "../Button/Button";
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
  onConfirm: () => void;
  /** Called on Cancel, Escape and clicking outside. */
  onCancel: () => void;
};

/**
 * A non-blocking replacement for `window.confirm` — same look as the app's
 * other confirmation dialogs (RemoveProjectDialog, TunnelConfirmDialog).
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
            <Button variant={confirmVariant} onClick={onConfirm}>
              {confirmLabel}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
