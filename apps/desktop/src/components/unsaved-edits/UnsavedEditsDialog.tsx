import * as Dialog from "@radix-ui/react-dialog";
import { useShallow } from "zustand/react/shallow";
import styles from "../sidebar/dialogs.module.css";
import { Button } from "../ui/Button/Button";
import { useOpenFileStore, unsavedFilesIn } from "../../store/open-file-store";
import {
  answerUnsavedGuard,
  dismissElsewhereNotice,
  useUnsavedGuardStore,
  type UnsavedGuardVerb,
} from "../../store/unsaved-guard-store";
import { UnsavedFiles } from "./UnsavedFiles";
import unsavedStyles from "./UnsavedFiles.module.css";

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
 * (`guardUnsavedEdits`). Without Cancel when this window lost its tab and
 * is closing anyway. And the notice that something here would close panes
 * with unsaved edits in another window, which only that window can save.
 */
export function UnsavedEditsDialog() {
  return (
    <>
      <UnsavedEditsConfirm />
      <UnsavedElsewhereNotice />
    </>
  );
}

function UnsavedEditsConfirm() {
  const request = useUnsavedGuardStore((s) => s.request);
  const saving = useUnsavedGuardStore((s) => s.saving);
  const files = useOpenFileStore(
    useShallow((s) => (request ? unsavedFilesIn(s, request.paneIds) : [])),
  );
  const verb = request?.verb ?? "move";
  const mustAnswer = request?.mustAnswer ?? false;

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
          <Dialog.Title className={styles.confirmTitle}>
            {mustAnswer ? "Tab Closed Elsewhere" : TITLE[verb]}
          </Dialog.Title>
          <Dialog.Description asChild className={styles.confirmDescription}>
            <div>
              {mustAnswer && (
                <div>This window&apos;s tab was closed or moved, so the window closes.</div>
              )}
              <UnsavedFiles files={files} end="." />
            </div>
          </Dialog.Description>
          <div className={styles.confirmActions}>
            {!mustAnswer && (
              <Button
                variant="secondary"
                data-testid="unsaved-edits-cancel"
                onClick={() => void answerUnsavedGuard("cancel")}
              >
                Cancel
              </Button>
            )}
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

/** "Unsaved changes in another window: <files>. Save or close them there first.", OK only. */
function UnsavedElsewhereNotice() {
  const notice = useUnsavedGuardStore((s) => s.elsewhere);
  const files = notice?.files ?? [];
  return (
    <Dialog.Root
      open={notice !== null}
      onOpenChange={(open) => {
        if (!open) dismissElsewhereNotice();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={styles.confirmOverlay} />
        <Dialog.Content className={styles.confirmDialog} data-testid="unsaved-elsewhere-dialog">
          <Dialog.Title className={styles.confirmTitle}>
            {notice ? TITLE[notice.verb] : ""}
          </Dialog.Title>
          <Dialog.Description asChild className={styles.confirmDescription}>
            <div>
              Unsaved changes in another window:{" "}
              {files.length === 1 ? (
                <b data-testid="unsaved-file" title={files[0]}>
                  {files[0]}
                </b>
              ) : (
                <ul className={unsavedStyles.list}>
                  {files.map((file, i) => (
                    <li key={`${i}:${file}`} className={unsavedStyles.file} data-testid="unsaved-file">
                      {file}
                    </li>
                  ))}
                </ul>
              )}
              {files.length === 1 ? ". " : ""}Save or close them there first.
            </div>
          </Dialog.Description>
          <div className={styles.confirmActions}>
            <Button
              variant="primary"
              data-testid="unsaved-elsewhere-ok"
              onClick={dismissElsewhereNotice}
              autoFocus
            >
              OK
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
