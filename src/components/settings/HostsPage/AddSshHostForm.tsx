import { useState } from "react";
import { useHostStore } from "../../../store/host-store";
import { ipcErrorMessage } from "../../../lib/ipc-error";
import { Input } from "../../ui/Input";
import { Button } from "../../ui/Button/Button";
import { Stack, Row } from "../../ui/Layout/Layout";
import styles from "../SettingsModal/SettingsModal.module.css";

type AddSshHostFormProps = {
  /** The host was registered; it goes on connecting in the background. */
  onAdded: (hostId: string) => void;
  onCancel: () => void;
};

/**
 * "An SSH box" (ADR-229 D8): an ssh target, registered as a host and
 * connected in the background. Shared by the Hosts page's Add host and a
 * project's Host section, which adds one inline to set the project up there.
 */
export function AddSshHostForm(props: AddSshHostFormProps) {
  const { onAdded, onCancel } = props;

  const addHost = useHostStore((s) => s.addHost);
  const hostBusy = useHostStore((s) => s.busy);
  const [target, setTarget] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const trimmed = target.trim();
    if (!trimmed) return;
    setError(null);
    addHost(trimmed).then(
      ({ hostId }) => {
        setTarget("");
        onAdded(hostId);
      },
      (err: unknown) => setError(ipcErrorMessage(err)),
    );
  };

  return (
    <Stack gap="xs" data-testid="add-ssh-host-form">
      <Input
        autoFocus
        data-testid="add-ssh-host-target"
        placeholder="user@host or an ssh config alias"
        value={target}
        disabled={hostBusy}
        onChange={(e) => setTarget(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
          if (e.key === "Escape") {
            // Cancel the form, not the settings modal.
            e.stopPropagation();
            onCancel();
          }
        }}
      />
      <Row gap="xs">
        <Button
          variant="secondary"
          size="sm"
          data-testid="add-ssh-host-connect"
          disabled={hostBusy || target.trim() === ""}
          onClick={submit}
        >
          Connect
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </Row>
      {error && <div className={styles.linearError}>{error}</div>}
    </Stack>
  );
}
