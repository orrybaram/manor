import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Button } from "../ui/Button/Button";
import { EmojiInput } from "../ui/EmojiAutocomplete";
import { useAgentStore } from "../../store/agent-store";
import { useProjectStore } from "../../store/project-store";
import dialogStyles from "../sidebar/dialogs.module.css";

/** What a rename acts on, with the name the field starts from. */
export type RenameTarget =
  | { kind: "workspace"; projectId: string; path: string; name: string }
  | { kind: "agent"; agentId: string; name: string };

const COPY = {
  workspace: {
    title: "Rename Workspace",
    description: "Leave it empty to go back to the branch name.",
    placeholder: "Workspace name",
  },
  agent: {
    title: "Rename Agent",
    description: "Leave it empty to go back to the agent's own title.",
    placeholder: "Agent name",
  },
} as const;

type RenameDialogProps = {
  target: RenameTarget;
  /** Called once the dialog closes, saved or not. */
  onDone: () => void;
};

/**
 * The phone's rename prompt, for a workspace or an agent — asked for from a
 * tab's long-press menu or the palette (`PhoneChrome` owns it). The desk
 * renames inline in the sidebar, which a phone only has inside a closed
 * drawer. Mounted only while open, so the field starts from `target.name`.
 * An empty name hands naming back to the default.
 */
export function RenameDialog(props: RenameDialogProps) {
  const { target, onDone } = props;

  const [name, setName] = useState(target.name);
  const copy = COPY[target.kind];

  const submit = () => {
    const trimmed = name.trim();
    if (target.kind === "workspace") {
      void useProjectStore
        .getState()
        .renameWorkspace(target.projectId, target.path, trimmed);
    } else {
      void useAgentStore.getState().renameAgent(target.agentId, trimmed);
    }
    onDone();
  };

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onDone();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={dialogStyles.confirmOverlay} />
        <Dialog.Content className={dialogStyles.confirmDialog} data-testid="phone-rename-dialog">
          <Dialog.Title className={dialogStyles.confirmTitle}>{copy.title}</Dialog.Title>
          <Dialog.Description className={dialogStyles.confirmDescription}>
            {copy.description}
          </Dialog.Description>
          <EmojiInput
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
            placeholder={copy.placeholder}
            className={dialogStyles.convertInput}
            data-testid="phone-rename-input"
          />
          <div className={dialogStyles.confirmActions}>
            <Button variant="secondary" onClick={onDone}>
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
