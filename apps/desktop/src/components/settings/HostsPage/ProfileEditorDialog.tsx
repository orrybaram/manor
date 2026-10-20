import * as Dialog from "@radix-ui/react-dialog";
import { useHostProfileStore } from "../../../store/host-profile-store";
import { StartHostForm } from "./StartHostForm";
import dialogStyles from "../../sidebar/dialogs.module.css";
import styles from "./HostsPage.module.css";

/**
 * The profile editor: `StartHostForm` in profile mode, in a
 * dialog. Opened by `openProfileEditor`; mount it once, wherever it may be
 * opened from.
 */
export function ProfileEditorDialog() {
  const editor = useHostProfileStore((s) => s.editor);
  const closeEditor = useHostProfileStore((s) => s.closeEditor);

  return (
    <Dialog.Root
      open={editor !== null}
      onOpenChange={(next) => {
        if (!next) closeEditor();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={dialogStyles.confirmOverlay} />
        <Dialog.Content
          className={`${dialogStyles.confirmDialog} ${styles.addHostDialog}`}
          data-testid="profile-editor"
          aria-describedby={undefined}
        >
          <Dialog.Title className={dialogStyles.confirmTitle}>
            {editor?.profile ? "Edit profile" : "New profile"}
          </Dialog.Title>
          {editor && (
            <div className={styles.wizardBody}>
              {/* Mounted per opening, so each starts afresh. */}
              <StartHostForm
                mode="profile"
                profile={editor.profile}
                onCancel={closeEditor}
                onSaved={(saved) => {
                  closeEditor();
                  editor.onSaved?.(saved);
                }}
              />
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
