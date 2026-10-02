import { useCallback, useState } from "react";
import Smartphone from "lucide-react/dist/esm/icons/smartphone";
import Laptop from "lucide-react/dist/esm/icons/laptop";
import Globe from "lucide-react/dist/esm/icons/globe";
import ShieldAlert from "lucide-react/dist/esm/icons/shield-alert";
import Trash2 from "lucide-react/dist/esm/icons/trash-2";

import { useRemoteControlStore } from "../../store/remote-control-store";
import { Button } from "../ui/Button/Button";
import { EmojiInput } from "../ui/EmojiAutocomplete";
import { Stack, Row } from "../ui/Layout/Layout";
import { Switch } from "../ui/Switch/Switch";
import { Tooltip } from "../ui/Tooltip/Tooltip";
import { relativeShort } from "../../utils/relative-time";
import {
  PairingResultDialog,
  RelayConfirmDialog,
  ResetRelayDialog,
} from "./RemoteControlDialogs";
import type {
  RemoteDeviceInfo,
  RemotePairResult,
  RelayStatus,
} from "../../electron.d";
import { SectionTitle } from "./SectionTitle";
import { isWebApp } from "../../lib/platform";
import styles from "./SettingsModal/SettingsModal.module.css";

/**
 * The remote-control settings surface (ADR-161 ticket 6).
 *
 * Three separate user actions, deliberately not collapsed into one: turning
 * remote control on, pairing a device, and starting the relay. Each widens
 * exposure by a different amount, and a single "turn on remote access" switch
 * would hide which of them the user actually agreed to.
 *
 * Once remote control is on, the relay is the main call to action: it sits on
 * the card that states whether the machine is reachable, above the devices.
 * The card states the exposure as a fact rather than leaving it to be
 * inferred from which controls are showing.
 */
export function RemoteControlPage() {
  const status = useRemoteControlStore((s) => s.status);
  const busy = useRemoteControlStore((s) => s.busy);
  const error = useRemoteControlStore((s) => s.error);
  const setEnabled = useRemoteControlStore((s) => s.setEnabled);
  const startRelay = useRemoteControlStore((s) => s.startRelay);
  const stopRelay = useRemoteControlStore((s) => s.stopRelay);
  const resetRelayAddress = useRemoteControlStore((s) => s.resetRelayAddress);
  const revoke = useRemoteControlStore((s) => s.revoke);
  const pair = useRemoteControlStore((s) => s.pair);

  const [label, setLabel] = useState("");
  const [pairing, setPairing] = useState<RemotePairResult | null>(null);
  const [relayConfirmOpen, setRelayConfirmOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);

  // `remoteControl.setEnabled/pair/revoke/startRelay/stopRelay` are
  // `localOnly` (ADR-180 D3) — a browser can read this page's status but
  // can't touch the switch, pairing form or relay controls.
  const webApp = isWebApp();
  const locked = webApp || busy || !status.encryptionAvailable;
  // Every pairing is a relay link (ADR-207 D4), so with no relay address
  // there is nothing to hand the device.
  const canPair = !locked && status.relayOrigin !== null;

  const handlePair = useCallback(async () => {
    const result = await pair(label.trim());
    if (result) {
      setPairing(result);
      setLabel("");
    }
  }, [label, pair]);

  return (
    <Stack className={styles.pageContent}>
      <div className={styles.notifToggleCard}>
        <div>
          <div className={styles.notifToggleTitle}>Remote control</div>
          <div className={styles.notifToggleDesc}>
            Check on your agents from your phone. Nothing on this machine
            listens for connections: devices reach it only through the Manor
            relay, once you start it. Remote control turns off again every time
            Manor restarts.
          </div>
        </div>
        <Switch
          data-testid="remote-control-switch"
          checked={status.enabled}
          disabled={locked}
          onCheckedChange={(checked) => void setEnabled(checked)}
        />
      </div>

      {webApp && (
        <div className={styles.sectionDescription}>
          This page isn&apos;t live from the browser yet — the switch, pairing
          and relay controls are read-only here.
        </div>
      )}

      {!status.encryptionAvailable && (
        <div className={styles.remoteWarning}>
          <ShieldAlert size={14} />
          <span>
            This machine cannot encrypt stored secrets, so device tokens cannot
            be saved safely. Remote control stays off rather than writing a
            bearer token to disk in plaintext.
          </span>
        </div>
      )}

      {error && <div className={styles.linearError}>{error}</div>}

      {status.enabled && (
        <>
          <RelayCard
            relay={status.relay}
            viewers={status.relayViewers}
            notice={status.relayNotice}
            locked={locked}
            onStart={() => setRelayConfirmOpen(true)}
            onStop={() => void stopRelay()}
            onReset={() => setResetOpen(true)}
          />

          <Stack gap="xs">
            <SectionTitle id="remote-devices">Devices</SectionTitle>
            <div className={styles.sectionDescription}>
              Every device gets its own relay link and token, shown once.
              Revoking one takes effect on its next request.
            </div>

            <Row gap="sm">
              <EmojiInput
                data-testid="remote-pair-label"
                placeholder="Device name, e.g. “my phone”"
                value={label}
                maxLength={64}
                disabled={!canPair}
                onChange={(e) => setLabel(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && label.trim()) void handlePair();
                }}
              />
              <Button
                data-testid="remote-pair-submit"
                variant="secondary"
                disabled={!canPair || label.trim().length === 0}
                onClick={() => void handlePair()}
              >
                Pair
              </Button>
            </Row>
            {status.relayOrigin === null ? (
              <div
                className={styles.fieldHint}
                data-testid="remote-pair-unavailable"
              >
                Pairing needs the Manor relay, and this machine has no valid
                relay address configured.
              </div>
            ) : (
              <div
                className={styles.remoteWarning}
                data-testid="remote-pair-warning"
              >
                <ShieldAlert size={14} />
                <span>
                  A paired device can do anything the desktop app can, including
                  removing workspaces, from anywhere its link is opened.
                </span>
              </div>
            )}
            {status.devices.length === 0 ? (
              <div className={styles.placeholder}>No devices paired yet</div>
            ) : (
              <div className={styles.remoteDeviceList}>
                {status.devices.map((device) => (
                  <DeviceRow
                    key={device.id}
                    device={device}
                    busy={locked}
                    onRevoke={() => void revoke(device.id)}
                  />
                ))}
              </div>
            )}
          </Stack>
        </>
      )}

      <RelayConfirmDialog
        open={relayConfirmOpen}
        onCancel={() => setRelayConfirmOpen(false)}
        onConfirm={() => {
          setRelayConfirmOpen(false);
          void startRelay();
        }}
      />

      <ResetRelayDialog
        open={resetOpen}
        devices={status.devices.length}
        onCancel={() => setResetOpen(false)}
        onConfirm={() => {
          setResetOpen(false);
          void resetRelayAddress();
        }}
      />

      <PairingResultDialog
        result={pairing}
        relayRunning={status.relay.state === "running"}
        onClose={() => setPairing(null)}
      />
    </Stack>
  );
}

/**
 * The Manor relay: reach this machine with nothing installed (ADR-206).
 *
 * The connector reports "cannot reach the relay, retrying" as `starting` with
 * an error, and gives up (`failed`) only on a verdict. The first is shown as
 * a warning that it is still trying, the second as an error to act on —
 * never as a bare "Connecting…" that hides why.
 */
function RelayCard(props: {
  relay: RelayStatus;
  /** Open relay channels. */
  viewers: number;
  notice: string | null;
  locked: boolean;
  onStart: () => void;
  onStop: () => void;
  onReset: () => void;
}) {
  const { relay, viewers, notice, locked } = props;

  const running = relay.state === "running";
  const starting = relay.state === "starting";
  const retrying = starting && relay.error !== null;
  return (
    <div
      data-settings-section="remote-relay"
      data-testid="remote-relay-card"
      tabIndex={-1}
      className={`${styles.remoteExposureCard} ${running ? styles.remoteExposureOpen : ""}`}
    >
      <div className={styles.remoteExposureIcon}>
        {running ? <Globe size={15} /> : <Laptop size={15} />}
      </div>
      <Stack gap="xs" className={styles.remoteExposureBody}>
        <div className={styles.remoteExposureHeader}>
          <div className={styles.remoteExposureTitle}>
            {running
              ? "Reachable through the Manor relay"
              : retrying
                ? "Can't reach the Manor relay"
                : "Manor relay (no install)"}
          </div>
          <Row gap="xs">
            <Button
              data-testid="remote-relay-reset"
              variant="ghost"
              disabled={locked}
              onClick={props.onReset}
            >
              Reset relay address
            </Button>
            {running || starting ? (
              <Button
                variant="secondary"
                onClick={props.onStop}
                data-testid="remote-relay-stop"
              >
                {starting ? "Cancel" : "Stop relay"}
              </Button>
            ) : (
              <Button
                data-testid="remote-relay-start"
                variant="primary"
                disabled={locked}
                onClick={props.onStart}
              >
                {relay.state === "failed" ? "Try again" : "Start relay"}
              </Button>
            )}
          </Row>
        </div>
        <div className={styles.fieldHint}>
          Open a link in any browser, with nothing to install on either end.
          Everything is end-to-end encrypted; the relay cannot read it. The
          relay stops when Manor quits.
        </div>
        {notice && (
          <div className={styles.linearError} data-testid="remote-relay-notice">
            {notice}
          </div>
        )}
        {relay.state === "failed" && relay.error && (
          <div className={styles.linearError}>{relay.error}</div>
        )}
        {retrying && (
          <div
            className={styles.remoteRetrying}
            data-testid="remote-relay-retrying"
          >
            Still trying — relay devices can&apos;t reach this machine until it
            connects. {relay.error}
          </div>
        )}
        {starting && !retrying && (
          <div className={styles.fieldHint}>Connecting…</div>
        )}
        {running && (
          <div className={styles.fieldHint}>
            {viewers === 0
              ? "No relay device connected"
              : `${viewers} relay device${viewers === 1 ? "" : "s"} connected`}
          </div>
        )}
      </Stack>
    </div>
  );
}

function DeviceRow(props: {
  device: RemoteDeviceInfo;
  busy: boolean;
  onRevoke: () => void;
}) {
  const { device, busy, onRevoke } = props;
  return (
    <div data-testid="remote-device-row" className={styles.remoteDeviceRow}>
      <Smartphone size={14} className={styles.remoteDeviceIcon} />
      <div className={styles.remoteDeviceBody}>
        <div className={styles.remoteDeviceLabel}>
          <span>{device.label}</span>
          {device.hasPush && (
            <span className={styles.remoteSendBadge}>push</span>
          )}
        </div>
        <div className={styles.fieldHint}>
          Paired {relativeShort(device.createdAt)} ·{" "}
          {device.lastSeenAt === null
            ? "not connected yet"
            : `last seen ${relativeShort(device.lastSeenAt)}`}
        </div>
      </div>
      <Tooltip label="Revoke this device's token">
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Revoke ${device.label}`}
          disabled={busy}
          onClick={onRevoke}
        >
          <Trash2 size={13} />
        </Button>
      </Tooltip>
    </div>
  );
}
