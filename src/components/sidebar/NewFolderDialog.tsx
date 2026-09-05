import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import styles from "./dialogs.module.css";
import { Button } from "../ui/Button/Button";
import { Input } from "../ui/Input/Input";

type NewFolderDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (name: string) => void;
};

export function NewFolderDialog(props: NewFolderDialogProps) {
  const { open, onOpenChange, onConfirm } = props;

  const [name, setName] = useState("");
  const [wasOpen, setWasOpen] = useState(open);

  // Clear the field each time the dialog is opened, without an effect.
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setName("");
  }

  const submit = () => {
    const trimmed = name.trim();
    if (trimmed) onConfirm(trimmed);
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.confirmOverlay} />
        <Dialog.Content className={styles.confirmDialog}>
          <Dialog.Title className={styles.confirmTitle}>New Folder</Dialog.Title>
          <Dialog.Description className={styles.confirmDescription}>
            Group workspaces in the sidebar. Folders do not change anything on
            disk.
          </Dialog.Description>
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
            placeholder="Folder name"
            className={styles.convertInput}
          />
          <div className={styles.confirmActions}>
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={submit}>
              Create
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
