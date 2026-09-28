import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import styles from "./dialogs.module.css";
import { Button } from "../ui/Button/Button";
import { EmojiInput } from "../ui/EmojiAutocomplete";
import type { WorkspaceHostChoice } from "../../lib/workspace-host-choices";
import { isRemoteHost } from "../../lib/hosts";
import { LocalHostLabel, RemoteHostLabel } from "../hosts/HostIndicator";
import { ToggleGroup } from "../ui/ToggleGroup";

type NewFolderDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `projectId` is the chosen host's member when `hostChoices` is given. */
  onConfirm: (name: string, projectId: string | null) => void;
  /**
   * Where the folder can go, one member project per host; the folder goes in
   * whichever host's section is picked.
   */
  hostChoices?: WorkspaceHostChoice[];
  /** The member selected when the dialog opens: the host it was opened from. */
  initialProjectId?: string | null;
};

export function NewFolderDialog(props: NewFolderDialogProps) {
  const { open, onOpenChange, onConfirm, hostChoices, initialProjectId = null } = props;

  const [name, setName] = useState("");
  const [projectId, setProjectId] = useState<string | null>(null);
  const [wasOpen, setWasOpen] = useState(open);

  // Clear the fields each time the dialog is opened, without an effect.
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setName("");
      setProjectId(null);
    }
  }

  const chosenProjectId =
    projectId ??
    hostChoices?.find((c) => c.projectId === initialProjectId)?.projectId ??
    hostChoices?.[0]?.projectId ??
    null;

  const submit = () => {
    const trimmed = name.trim();
    if (trimmed) onConfirm(trimmed, chosenProjectId);
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
          <EmojiInput
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
            placeholder="Folder name"
            className={styles.convertInput}
          />
          {hostChoices && chosenProjectId && (
            <ToggleGroup
              value={chosenProjectId}
              onChange={setProjectId}
              size="xs"
              aria-label="Host"
              data-testid="new-folder-host-picker"
              options={hostChoices.map((choice) => ({
                value: choice.projectId,
                label: isRemoteHost(choice.hostId) ? (
                  <RemoteHostLabel hostId={choice.hostId} />
                ) : (
                  <LocalHostLabel />
                ),
              }))}
            />
          )}
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
