import * as Dialog from "@radix-ui/react-dialog";
import { useShallow } from "zustand/react/shallow";
import styles from "../sidebar/dialogs.module.css";
import { Button } from "../ui/Button/Button";
import { useOpenFileStore, unsavedFilesIn } from "../../store/open-file-store";
import {
  answerUnsavedGuard,
  useUnsavedGuardStore,
  type UnsavedGuardVerb,
} from "../../store/unsaved-guard-store";
import { UnsavedFiles } from "./UnsavedFiles";

const TITLE: Record<UnsavedGuardVerb, string> = {
  move: "Move Pane",
  convert: "Convert Pane",
  close: "Close Tabs",
  remove: "Remove Workspace",
  merge: "Merge Workspace",
};

/**
 * Save and <verb> / Discard and <verb> / Cancel, in front of anything that
 * would take file panes' unsaved edits out of this window
 * (`guardUnsavedEdits`).
 */
export function UnsavedEditsDialog() {
  const request = useUnsavedGuardStore((s) => s.request);
  const saving = useUnsavedGuardStore((s) => s.saving);
  const files = useOpenFileStore(
    useShallow((s) => (request ? unsavedFilesIn(s, request.paneIds) : [])),
  );
  const verb = request?.verb ?? "move";

  return (
    <Dialog.Root
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) void answerUnsavedGuard("cancel");
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={styles.confirmOverlay} />
        <Dialog.Content className={styles.confirmDialog} data-testid="unsaved-edits-dialog">
          <Dialog.Title className={styles.confirmTitle}>{TITLE[verb]}</Dialog.Title>
          <Dialog.Description asChild className={styles.confirmDescription}>
            <div>
              <UnsavedFiles files={files} end="." />
            </div>
          </Dialog.Description>
          <div className={styles.confirmActions}>
            <Button
              variant="secondary"
              data-testid="unsaved-edits-cancel"
              onClick={() => void answerUnsavedGuard("cancel")}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              data-testid="unsaved-edits-discard"
              disabled={saving}
              onClick={() => void answerUnsavedGuard("discard")}
            >
              Discard and {verb}
            </Button>
            <Button
              variant="primary"
              data-testid="unsaved-edits-save"
              disabled={saving}
              onClick={() => void answerUnsavedGuard("save")}
            >
              Save and {verb}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
