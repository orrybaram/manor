import { useState } from "react";
import ShieldAlert from "lucide-react/dist/esm/icons/shield-alert";
import Plus from "lucide-react/dist/esm/icons/plus";

import { useMountEffect } from "../../hooks/useMountEffect";
import { Button } from "../ui/Button/Button";
import { Link } from "../ui/Link/Link";
import { Row, Stack } from "../ui/Layout/Layout";
import { Switch } from "../ui/Switch/Switch";
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
import { SettingRow } from "./SettingRow";
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
 *
 * Above it, "Phones paired with this Mac can reach <host>" (ADR-228 D9): the
 * phones paired with this computer are paired here too, and listed "via This
 * Mac". It works with the host away, since turning it off is a revoke the host
 * is then owed.
 */
export function HostPhoneAccess(props: { hostId: string; hostName: string }) {
  const { hostId, hostName } = props;
  const view = useHostStore((s) => s.servers[hostId]) ?? null;
  const devices = view?.devices ?? [];
  const linked = new Set(view?.linkedDeviceIds ?? []);
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

  // Whether this computer has a Linear key to hand the host (ADR-227 D7).
  const [desktopLinear, setDesktopLinear] = useState(false);

  useMountEffect(() => {
    void useHostStore.getState().refreshServer(hostId);
    void window.electronAPI.linear.isConnected().then(setDesktopLinear);
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
      {view !== null && (
        <SettingRow
          label={`Phones paired with this Mac can reach ${hostName}`}
          hint={`Each phone paired in Remote control is paired with ${hostName} too, so it keeps reaching ${hostName} while this computer sleeps. Turning this off unpairs them from ${hostName}.`}
        >
          <Switch
            data-testid="host-link-phones-toggle"
            checked={view.linkPhones}
            disabled={busy}
            onCheckedChange={(on) =>
              void run(() => useHostStore.getState().setLinkPhones(hostId, on))
            }
          />
        </SettingRow>
      )}
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
          {(desktopLinear || status.linear) && (
            <SettingRow
              label={`Use Linear on ${hostName}`}
              hint={`Copies this computer's Linear key to ${hostName}, so its phones can browse and start issues. Turn off, or reset pairing keys, to delete the copy.`}
            >
              <Switch
                data-testid="host-linear-toggle"
                checked={status.linear}
                disabled={busy}
                onCheckedChange={(on) =>
                  void run(async () => {
                    await window.electronAPI.hosts.setLinearOnHost(hostId, on);
                  })
                }
              />
            </SettingRow>
          )}
          {devices.length > 0 && (
            <div className={styles.remoteDeviceList}>
              {devices.map((device) => (
                <DeviceRow
                  key={device.id}
                  device={device}
                  via={linked.has(device.id) ? "This Mac" : undefined}
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
      {status.secretKeyOnVolume && (
        <div className={styles.remoteWarning} data-testid="host-key-on-volume">
          <ShieldAlert size={14} />
          <span>
            The key sealing pairing keys on {hostName} is stored on its own
            disk.{" "}
            <Link href={SECRETS_DOCS_URL}>How to keep it elsewhere</Link>
          </span>
        </div>
      )}
      {status.identityReset === "cloned" && (
        <div className={styles.fieldHint} data-testid="host-identity-reset">
          {hostName} was copied from another machine, so it got new pairing
          keys. Phones paired with this Mac re-link on their own.
        </div>
      )}
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
