import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useMountEffect } from "../../../hooks/useMountEffect";
import { ipcErrorMessage } from "../../../lib/ipc-error";
import { Button } from "../../ui/Button/Button";
import { Input } from "../../ui/Input";
import { Stack } from "../../ui/Layout/Layout";
import dialogStyles from "../../sidebar/dialogs.module.css";
import settingsStyles from "../SettingsModal/SettingsModal.module.css";
import styles from "./HostsPage.module.css";

type RemoveHostDialogProps = {
  open: boolean;
  hostId: string;
  hostName: string;
  /** Its provider can delete the box and its disk. */
  canDestroy: boolean;
  /** Resolves once the host is removed; rejects saying why it was not. */
  onRemove: (destroy: boolean) => Promise<void>;
  onClose: () => void;
};

/**
 * Remove a host, at one of two levels:
 *
 * - **Remove from Manor** forgets the host. The box goes on running; a
 *   plain confirm is enough.
 * - **Destroy host and its disk**, only where the provider can, deletes the
 *   box. The host is its projects' source of truth, so their
 *   workspace names, folders and linked issues go with it: the dialog lists
 *   them, and the button waits for the host's name to be typed.
 */
export function RemoveHostDialog(props: RemoveHostDialogProps) {
  const { open, onClose } = props;

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={dialogStyles.confirmOverlay} />
        <Dialog.Content
          className={`${dialogStyles.confirmDialog} ${styles.removeDialog}`}
          data-testid="host-remove-dialog"
          aria-describedby={undefined}
        >
          {/* Mounted per opening: the typed name and the project list start over. */}
          <RemoveHostBody {...props} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function RemoveHostBody(props: RemoveHostDialogProps) {
  const { hostId, hostName, canDestroy, onRemove, onClose } = props;

  const [typed, setTyped] = useState("");
  const [projects, setProjects] = useState<string[] | null>(null);
  const [action, setAction] = useState<{ busy: boolean; error: string | null }>({
    busy: false,
    error: null,
  });
  const { busy, error } = action;

  useMountEffect(() => {
    if (!canDestroy) return;
    let live = true;
    window.electronAPI.hosts.projectsOnHost(hostId).then(
      (names) => {
        if (live) setProjects(names);
      },
      () => {
        if (live) setProjects([]);
      },
    );
    return () => {
      live = false;
    };
  });

  const remove = (destroy: boolean) => {
    setAction({ busy: true, error: null });
    onRemove(destroy).then(
      () => onClose(),
      (err: unknown) => setAction({ busy: false, error: ipcErrorMessage(err) }),
    );
  };

  const confirmed = typed.trim() === hostName;

  return (
    <>
      <Dialog.Title className={dialogStyles.confirmTitle}>Remove {hostName}?</Dialog.Title>
      <Stack gap="md">
        <Stack gap="xs">
          <div className={dialogStyles.confirmDescription}>
            <strong>Remove from Manor</strong> forgets {hostName} here: its projects leave the
            sidebar, and phones reach it only through their own pairing with it. The host
            itself, and everything on it, stays as it is.
          </div>
          <div className={dialogStyles.confirmActions}>
            <Button
              variant="secondary"
              data-testid="host-remove-plain"
              disabled={busy}
              onClick={() => remove(false)}
            >
              Remove from Manor
            </Button>
          </div>
        </Stack>

        {canDestroy && (
          <Stack gap="xs">
            <div className={dialogStyles.confirmDescription}>
              <strong>Destroy host and its disk</strong> deletes {hostName} with its recipe's{" "}
              <code>destroy</code>. These projects live only there; their workspace names,
              folders and linked issues go with it. Branches pushed to a remote survive.
            </div>
            <div data-testid="host-destroy-projects" className={styles.projectList}>
              {projects === null
                ? "Reading its projects…"
                : projects.length === 0
                  ? "No projects on it."
                  : projects.join(", ")}
            </div>
            <Input
              data-testid="host-destroy-input"
              placeholder={`Type ${hostName} to confirm`}
              aria-label={`Type ${hostName} to confirm`}
              value={typed}
              disabled={busy}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && confirmed && !busy) remove(true);
              }}
            />
            <div className={dialogStyles.confirmActions}>
              <Button
                variant="danger"
                data-testid="host-destroy-confirm"
                disabled={!confirmed || busy}
                onClick={() => remove(true)}
              >
                Destroy host and its disk
              </Button>
            </div>
          </Stack>
        )}

        {error && (
          <div className={settingsStyles.linearError} data-testid="host-remove-error">
            {error}
          </div>
        )}
      </Stack>
      <div className={dialogStyles.confirmActions}>
        <Button variant="ghost" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
      </div>
    </>
  );
}
