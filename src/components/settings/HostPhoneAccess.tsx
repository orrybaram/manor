import { useState } from "react";
import ShieldAlert from "lucide-react/dist/esm/icons/shield-alert";
import Plus from "lucide-react/dist/esm/icons/plus";

import { useMountEffect } from "../../hooks/useMountEffect";
import { Button } from "../ui/Button/Button";
import { Link } from "../ui/Link/Link";
import { Row, Stack } from "../ui/Layout/Layout";
import type {
  HostServerStatus,
  HostServerView,
  RemotePairResult,
} from "../../electron.d";
import { useHostStore } from "../../store/host-store";
import {
  AddDeviceDialog,
  PairingResultDialog,
  ResetRelayDialog,
} from "./RemoteControlDialogs";
import { DeviceRow } from "./DeviceRow";
import { SectionTitle } from "./SectionTitle";
import styles from "./SettingsModal/SettingsModal.module.css";

/** Where enabling systemd-creds on a host is explained (ADR-225 D6). */
const SECRETS_DOCS_URL =
  "https://github.com/orrybaram/manor/blob/main/docs/remote-hosts.md#encrypting-pairing-keys";

/**
 * Phone access through one remote host's own Manor server (ADR-225 D3).
 *
 * A phone paired here reaches only this host, and keeps working while this
 * computer sleeps. A host that is not reachable, or that has no server yet,
 * gets one quiet line instead of an error: both resolve themselves when the
 * host reconnects.
 */
export function HostPhoneAccess(props: { hostId: string; hostName: string }) {
  const { hostId, hostName } = props;
  const view = useHostStore((s) => s.servers[hostId]) ?? null;
  const devices = view?.devices ?? [];
  // The store refreshes on the server and pairing events, so the calls below
  // only await; nothing here reloads.
  const [action, setAction] = useState<{ busy: boolean; error: string | null }>({
    busy: false,
    error: null,
  });
  const { busy, error } = action;
  const [dialog, setDialog] = useState<"add" | "reset" | null>(null);
  const [pairing, setPairing] = useState<RemotePairResult | null>(null);
  const addOpen = dialog === "add";

  useMountEffect(() => {
    void useHostStore.getState().refreshServer(hostId);
  });

  const run = async (action: () => Promise<void>) => {
    setAction({ busy: true, error: null });
    try {
      await action();
      setAction({ busy: false, error: null });
    } catch (err) {
      setAction({
        busy: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const status = view?.status ?? null;

  return (
    <Stack gap="xs" data-testid="host-phone-access">
      <SectionTitle id={`remote-host-${hostId}`}>{hostName}</SectionTitle>
      {status === null ? (
        <div className={styles.fieldHint} data-testid="host-phone-access-state">
          {mutedLine(view?.state ?? null)}
        </div>
      ) : (
        <>
          <HostSummary
            status={status}
            phones={devices.length}
            hostName={hostName}
          />
          {error && !addOpen && (
            <div className={styles.linearError}>{error}</div>
          )}
          <Row align="center" justify="space-between">
            <div className={styles.fieldHint}>
              A phone paired here reaches only {hostName}, and keeps working
              while this computer sleeps.
            </div>
            <Button
              data-testid="host-pair-phone"
              variant={devices.length === 0 ? "primary" : "secondary"}
              size="sm"
              disabled={busy}
              onClick={() => {
                setAction({ busy: false, error: null });
                setDialog("add");
              }}
            >
              <Plus size={13} />
              Pair a phone
            </Button>
          </Row>
          {devices.length > 0 && (
            <div className={styles.remoteDeviceList}>
              {devices.map((device) => (
                <DeviceRow
                  key={device.id}
                  device={device}
                  busy={busy}
                  onRevoke={() =>
                    void run(async () => {
                      await window.electronAPI.hosts.revokeDevice(
                        hostId,
                        device.id,
                      );
                    })
                  }
                />
              ))}
            </div>
          )}
          <Button
            data-testid="host-reset-keys"
            variant="link"
            className={styles.remoteResetLink}
            disabled={busy}
            onClick={() => setDialog("reset")}
          >
            Reset pairing keys…
          </Button>
        </>
      )}

      <AddDeviceDialog
        open={addOpen}
        enabled
        busy={busy}
        error={error}
        hostName={hostName}
        onCancel={() => setDialog(null)}
        onPair={(label) =>
          void run(async () => {
            const result = await window.electronAPI.hosts.pairDevice(
              hostId,
              label,
            );
            setDialog(null);
            setPairing(result);
          })
        }
      />
      <ResetRelayDialog
        open={dialog === "reset"}
        devices={devices.length}
        hostName={hostName}
        onCancel={() => setDialog(null)}
        onConfirm={() => {
          setDialog(null);
          void run(async () => {
            await window.electronAPI.hosts.resetPairingKeys(hostId);
          });
        }}
      />
      <PairingResultDialog
        result={pairing}
        relayUp={status?.relay.connected ?? false}
        onClose={() => setPairing(null)}
      />
    </Stack>
  );
}

/** The one muted line for a host whose server cannot be asked right now. */
function mutedLine(state: HostServerView["state"] | null): string {
  if (state === null) return "Checking phone access…";
  if (state === "idle" || state === "connecting") return "Updating…";
  return "Phone access needs the host to reconnect";
}

function HostSummary(props: {
  status: HostServerStatus;
  /** Counted from the device list that arrived with the status. */
  phones: number;
  hostName: string;
}) {
  const { status, phones, hostName } = props;
  return (
    <Stack gap="xs">
      <div className={styles.fieldHint} data-testid="host-phone-summary">
        Manor {status.version} ·{" "}
        {phones === 0
          ? "no phones paired"
          : `${phones} phone${phones === 1 ? "" : "s"} paired`}{" "}
        · {status.relay.connected ? "relay connected" : "relay not connected"}
        {!status.relay.connected && status.relay.error
          ? ` (${status.relay.error})`
          : ""}
      </div>
      {status.secretBackend === "plaintext" && (
        <div className={styles.remoteWarning} data-testid="host-plaintext-keys">
          <ShieldAlert size={14} />
          <span>
            Pairing keys on {hostName} are stored unencrypted.{" "}
            <Link href={SECRETS_DOCS_URL}>How to encrypt them</Link>
          </span>
        </div>
      )}
    </Stack>
  );
}
