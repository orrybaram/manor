import { useState } from "react";
import Moon from "lucide-react/dist/esm/icons/moon";
import RotateCcw from "lucide-react/dist/esm/icons/rotate-ccw";
import Trash2 from "lucide-react/dist/esm/icons/trash-2";
import { useHostStore, type HostStatusInfo } from "../../../store/host-store";
import { useMountEffect } from "../../../hooks/useMountEffect";
import { ipcErrorMessage } from "../../../lib/ipc-error";
import { Button } from "../../ui/Button/Button";
import { Stack } from "../../ui/Layout/Layout";
import { Switch } from "../../ui/Switch/Switch";
import { HostCard, HostCardRow } from "../../hosts/HostCard";
import { SettingRow } from "../SettingRow";
import { useSettingsNav } from "../SettingsModal/settings-nav";
import { RemoveHostDialog } from "./RemoveHostDialog";
import { idleStopText, supervisionHint, supervisorStatusText } from "./host-settings-text";
import settingsStyles from "../SettingsModal/SettingsModal.module.css";
import styles from "./HostsPage.module.css";

/** How the Hosts page names this computer in "only while … is awake". */
const DESKTOP_NAME = "This Mac";

type HostEntryProps = {
  host: HostStatusInfo;
  /** How the host is named (`hostName`). */
  name: string;
  /** A browser: the host's status and Wake, nothing that is the desktop's to do. */
  readOnly: boolean;
};

/**
 * One remote host on the Hosts page (ADR-229 D8): its card (status, Retry,
 * Wake), what its provider lets Manor do to it (Stop; Start it again for a
 * box deleted outside Manor), its supervision switch and what supervises
 * it, the idle-stop caveat, a link to its phone access, and Remove….
 */
export function HostEntry(props: HostEntryProps) {
  const { host, name, readOnly } = props;

  const { hostId } = host;
  const view = useHostStore((s) => s.servers[hostId]) ?? null;
  const goTo = useSettingsNav();
  const [removing, setRemoving] = useState(false);
  const [action, setAction] = useState<{ busy: boolean; error: string | null }>({
    busy: false,
    error: null,
  });
  const { busy, error } = action;

  useMountEffect(() => {
    // The supervision switch reads the server's view; a browser can't ask.
    if (!readOnly) void useHostStore.getState().refreshServer(hostId);
  });

  const run = (work: () => Promise<void>) => {
    setAction({ busy: true, error: null });
    work().then(
      () => setAction({ busy: false, error: null }),
      (err: unknown) => setAction({ busy: false, error: ipcErrorMessage(err) }),
    );
  };

  const connected = host.status === "connected";
  const canStop = host.capabilities?.canStop === true && connected;
  const missing = host.status === "error" && host.missing === true;

  const actions = readOnly ? null : (
    <>
      {canStop && (
        <Button
          size="sm"
          variant="secondary"
          data-testid="host-stop"
          disabled={busy}
          onClick={() => run(() => useHostStore.getState().stop(hostId))}
        >
          <Moon size={11} aria-hidden className={styles.buttonIcon} />
          Stop
        </Button>
      )}
      {missing && (
        <Button
          size="sm"
          variant="primary"
          data-testid="host-start-again"
          disabled={busy}
          onClick={() => run(() => useHostStore.getState().wake(hostId))}
        >
          <RotateCcw size={11} aria-hidden className={styles.buttonIcon} />
          Start it again
        </Button>
      )}
      <Button
        size="sm"
        variant="ghost"
        data-testid="host-remove"
        disabled={busy}
        onClick={() => setRemoving(true)}
      >
        <Trash2 size={11} aria-hidden className={styles.buttonIcon} />
        Remove…
      </Button>
    </>
  );

  const supervisorLine = supervisorStatusText(view?.supervisor ?? null, name, host.spec);
  // `supervise` is the container's entrypoint: there is nothing to turn off.
  const inContainer = view?.supervisor?.kind === "container";
  const hint = supervisionHint(view, name, connected);

  return (
    <Stack gap="xs" data-testid="host-entry" data-host-id={hostId}>
      <HostCard hostId={hostId} actions={actions}>
        {error && (
          <HostCardRow tone="error">
            <span data-testid="host-entry-error">{error}</span>
          </HostCardRow>
        )}
      </HostCard>
      <div className={styles.hostSettings}>
        {!readOnly && (
          <SettingRow
            label={`Keep Manor running when ${name} restarts`}
            hint={
              <span data-testid="host-supervisor-status">
                {supervisorLine ?? hint}
              </span>
            }
          >
            <Switch
              data-testid="host-supervise-toggle"
              checked={inContainer || (view?.supervise ?? false)}
              disabled={!connected || busy || view === null || inContainer}
              onCheckedChange={(on) =>
                run(() => useHostStore.getState().setSupervised(hostId, on))
              }
            />
          </SettingRow>
        )}
        {host.idleStopNote && (
          <div className={settingsStyles.fieldHint} data-testid="host-idle-stop-note">
            {idleStopText(host.idleStopMinutes, DESKTOP_NAME)}
          </div>
        )}
        {!readOnly && (
          <Button
            variant="link"
            data-testid="host-phone-access-link"
            onClick={() => goTo({ type: "remote" }, `remote-host-${hostId}`)}
          >
            Phone access for {name}
          </Button>
        )}
      </div>
      {!readOnly && (
        <RemoveHostDialog
          open={removing}
          hostId={hostId}
          hostName={name}
          canDestroy={host.capabilities?.canDestroy === true}
          onRemove={(destroy) => useHostStore.getState().removeHost(hostId, destroy)}
          onClose={() => setRemoving(false)}
        />
      )}
    </Stack>
  );
}
