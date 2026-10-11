import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Button } from "../ui/Button/Button";
import { EmojiInput } from "../ui/EmojiAutocomplete";
import dialogStyles from "../sidebar/dialogs.module.css";

type RenameDialogProps = {
  open: boolean;
  title: string;
  description: string;
  /** The name the field starts with each time the dialog opens. */
  initialName: string;
  placeholder: string;
  /** Called with the trimmed name; empty hands naming back to the default. */
  onConfirm: (name: string) => void;
  onOpenChange: (open: boolean) => void;
};

/**
 * The phone's rename prompt, opened from the top bar's overflow menu. The
 * desk renames inline in the sidebar, which a phone only has inside a closed
 * drawer.
 */
export function RenameDialog(props: RenameDialogProps) {
  const { open, title, description, initialName, placeholder, onConfirm, onOpenChange } =
    props;

  const [name, setName] = useState(initialName);
  const [wasOpen, setWasOpen] = useState(open);

  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setName(initialName);
  }

  const submit = () => {
    onConfirm(name.trim());
    onOpenChange(false);
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={dialogStyles.confirmOverlay} />
        <Dialog.Content className={dialogStyles.confirmDialog} data-testid="phone-rename-dialog">
          <Dialog.Title className={dialogStyles.confirmTitle}>{title}</Dialog.Title>
          <Dialog.Description className={dialogStyles.confirmDescription}>
            {description}
          </Dialog.Description>
          <EmojiInput
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
            placeholder={placeholder}
            className={dialogStyles.convertInput}
            data-testid="phone-rename-input"
          />
          <div className={dialogStyles.confirmActions}>
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={submit} data-testid="phone-rename-save">
              Save
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
