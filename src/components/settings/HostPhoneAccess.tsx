import { useCallback, useState } from "react";
import ShieldAlert from "lucide-react/dist/esm/icons/shield-alert";
import Plus from "lucide-react/dist/esm/icons/plus";

import { useMountEffect } from "../../hooks/useMountEffect";
import { Button } from "../ui/Button/Button";
import { Link } from "../ui/Link/Link";
import { Row, Stack } from "../ui/Layout/Layout";
import type {
  HostServerStatus,
  HostServerView,
  RemoteDeviceInfo,
  RemotePairResult,
} from "../../electron.d";
import { AddDeviceDialog, PairingResultDialog } from "./RemoteControlDialogs";
import { DeviceRow } from "./DeviceRow";
import { SectionTitle } from "./SectionTitle";
import styles from "./SettingsModal/SettingsModal.module.css";

/** Where enabling systemd-creds on a host is explained (ADR-218 D6). */
const SECRETS_DOCS_URL =
  "https://github.com/orrybaram/manor/blob/main/docs/remote-hosts.md#encrypting-pairing-keys";

/**
 * Phone access through one remote host's own Manor server (ADR-218 D3).
 *
 * A phone paired here reaches only this host, and keeps working while this
 * computer sleeps. A host that is not reachable, or that has no server yet,
 * gets one quiet line instead of an error: both resolve themselves when the
 * host reconnects.
 */
export function HostPhoneAccess(props: { hostId: string; hostName: string }) {
  const { hostId, hostName } = props;
  const [view, setView] = useState<HostServerView | null>(null);
  const [devices, setDevices] = useState<RemoteDeviceInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [pairing, setPairing] = useState<RemotePairResult | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  const load = useCallback(async () => {
    const api = window.electronAPI.hosts;
    try {
      const next = await api.serverStatus(hostId);
      setView(next);
      setDevices(next.status ? await api.listDevices(hostId) : []);
    } catch {
      setView({ state: "disconnected", status: null });
    }
  }, [hostId]);

  useMountEffect(() => {
    void load();
    return window.electronAPI.hosts.onServerChanged((info) => {
      if (info.hostId === hostId) void load();
    });
  });

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
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
          <HostSummary status={status} hostName={hostName} />
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
                setError(null);
                setAddOpen(true);
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
                      setDevices(
                        await window.electronAPI.hosts.revokeDevice(
                          hostId,
                          device.id,
                        ),
                      );
                    })
                  }
                />
              ))}
            </div>
          )}
          {confirmReset ? (
            <Stack gap="xs" data-testid="host-reset-confirm">
              <div className={styles.fieldHint}>
                This disconnects every phone paired with {hostName}. They will
                need to be paired again.
              </div>
              <Row gap="xs">
                <Button
                  data-testid="host-reset-confirm-yes"
                  variant="danger"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await window.electronAPI.hosts.resetPairingKeys(hostId);
                      setConfirmReset(false);
                      await load();
                    })
                  }
                >
                  Reset pairing keys
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={() => setConfirmReset(false)}
                >
                  Cancel
                </Button>
              </Row>
            </Stack>
          ) : (
            <Button
              data-testid="host-reset-keys"
              variant="link"
              className={styles.remoteResetLink}
              disabled={busy}
              onClick={() => setConfirmReset(true)}
            >
              Reset pairing keys…
            </Button>
          )}
        </>
      )}

      <AddDeviceDialog
        open={addOpen}
        enabled
        busy={busy}
        error={error}
        hostName={hostName}
        onCancel={() => setAddOpen(false)}
        onPair={(label) =>
          void run(async () => {
            const result = await window.electronAPI.hosts.pairDevice(
              hostId,
              label,
            );
            setAddOpen(false);
            setPairing(result);
            await load();
          })
        }
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

function HostSummary(props: { status: HostServerStatus; hostName: string }) {
  const { status, hostName } = props;
  return (
    <Stack gap="xs">
      <div className={styles.fieldHint} data-testid="host-phone-summary">
        Manor {status.version} ·{" "}
        {status.devices === 0
          ? "no phones paired"
          : `${status.devices} phone${status.devices === 1 ? "" : "s"} paired`}{" "}
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
