import { useCallback, useState } from "react";
import Smartphone from "lucide-react/dist/esm/icons/smartphone";
import ShieldAlert from "lucide-react/dist/esm/icons/shield-alert";
import Trash2 from "lucide-react/dist/esm/icons/trash-2";
import Plus from "lucide-react/dist/esm/icons/plus";

import { useRemoteControlStore } from "../../store/remote-control-store";
import { Button } from "../ui/Button/Button";
import { Stack, Row } from "../ui/Layout/Layout";
import { Switch } from "../ui/Switch/Switch";
import { Tooltip } from "../ui/Tooltip/Tooltip";
import { relativeShort } from "../../utils/relative-time";
import {
  AddDeviceDialog,
  CopyLinkButton,
  PairingQr,
  PairingResultDialog,
  RelayConfirmDialog,
  ResetRelayDialog,
} from "./RemoteControlDialogs";
import type {
  RemoteControlStatus,
  RemoteDeviceInfo,
  RemotePairResult,
} from "../../electron.d";
import { SectionTitle } from "./SectionTitle";
import { isWebApp } from "../../lib/platform";
import styles from "./SettingsModal/SettingsModal.module.css";

/**
 * The remote-control settings surface.
 *
 * One control: remote control on means the relay is running, or trying to
 * be. Turning it on is the confirmed, outward-facing action; pairing a device
 * turns it on too, behind the same "full control" warning, so the link handed
 * over works straight away.
 *
 * While the relay is live the status card shows a QR code for the web app
 * with no credentials in it: a phone that was already paired keeps its
 * pairing in its own storage, so this is how it gets back in without
 * re-pairing.
 */
export function RemoteControlPage() {
  const status = useRemoteControlStore((s) => s.status);
  const busy = useRemoteControlStore((s) => s.busy);
  const error = useRemoteControlStore((s) => s.error);
  const turnOn = useRemoteControlStore((s) => s.turnOn);
  const turnOff = useRemoteControlStore((s) => s.turnOff);
  const resetRelayAddress = useRemoteControlStore((s) => s.resetRelayAddress);
  const revoke = useRemoteControlStore((s) => s.revoke);
  const pair = useRemoteControlStore((s) => s.pair);
  const clearError = useRemoteControlStore((s) => s.clearError);

  const [addOpen, setAddOpen] = useState(false);
  const [pairing, setPairing] = useState<RemotePairResult | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);

  // `remoteControl.setEnabled/pair/revoke/startRelay/stopRelay` are
  // `localOnly` (ADR-180 D3) — a browser can read this page's status but
  // can't touch the switch, pairing or relay controls.
  const webApp = isWebApp();
  const locked = webApp || busy || !status.encryptionAvailable;

  const handlePair = useCallback(
    async (label: string) => {
      const result = await pair(label);
      if (result) {
        setAddOpen(false);
        setPairing(result);
      }
    },
    [pair],
  );

  const openAdd = () => {
    clearError();
    setAddOpen(true);
  };

  const relayUp =
    status.relay.state === "running" || status.relay.state === "starting";
  const on = isOn(status);

  return (
    <Stack className={styles.pageContent}>
      <StatusCard
        status={status}
        locked={locked}
        onToggle={(checked) =>
          checked ? setConfirmOpen(true) : void turnOff()
        }
        onRetry={() => void turnOn()}
      />

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

      {error && !addOpen && <div className={styles.linearError}>{error}</div>}

      <Stack gap="xs">
        <Row
          align="center"
          justify="space-between"
          className={styles.remoteDevicesHeader}
        >
          <SectionTitle id="remote-devices">Devices</SectionTitle>
          {status.devices.length > 0 && (
            <Button
              data-testid="remote-add-device"
              variant="secondary"
              size="sm"
              disabled={locked}
              onClick={openAdd}
            >
              <Plus size={13} />
              Add device
            </Button>
          )}
        </Row>
        {status.devices.length === 0 ? (
          <div className={styles.remoteEmpty}>
            <span>
              No devices yet. Pair your phone to check on agents away from
              your desk.
            </span>
            <Button
              data-testid="remote-add-device"
              variant="primary"
              disabled={locked}
              onClick={openAdd}
            >
              <Plus size={13} />
              Add device
            </Button>
          </div>
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
        {status.devices.length > 0 && (
          <Button
            data-testid="remote-relay-reset"
            variant="link"
            className={styles.remoteResetLink}
            disabled={locked}
            onClick={() => setResetOpen(true)}
          >
            Reset relay address…
          </Button>
        )}
      </Stack>

      <RelayConfirmDialog
        open={confirmOpen}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => {
          setConfirmOpen(false);
          void turnOn();
        }}
      />

      <AddDeviceDialog
        open={addOpen}
        enabled={on}
        busy={locked}
        error={error}
        onCancel={() => setAddOpen(false)}
        onPair={(label) => void handlePair(label)}
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
        relayUp={relayUp}
        onClose={() => setPairing(null)}
      />
    </Stack>
  );
}

type StatusView = {
  tone: "off" | "ok" | "pending" | "bad";
  title: string;
  detail: string;
  /** A button beside the switch: retrying a relay that is down. */
  retry: string | null;
};

/**
 * Whether the page shows remote control as on. Enabled with the relay stopped
 * (after a reset, or enabled through the agent API, which never starts the
 * relay) reaches nothing, so it reads as off; turning it on starts the relay.
 */
function isOn(status: RemoteControlStatus): boolean {
  return status.enabled && status.relay.state !== "stopped";
}

/**
 * What the card says for each state. The connector reports "cannot reach the
 * relay, retrying" as `starting` with an error and gives up (`failed`) only
 * on a verdict — the first is a warning that it is still trying, the second
 * an error to act on, never a bare "Connecting…" that hides why.
 */
function describe(status: RemoteControlStatus): StatusView {
  const { relay } = status;
  if (!isOn(status)) {
    return {
      tone: "off",
      title: "Remote control is off",
      detail:
        "Turn on to check on your agents from your phone. Turns off again when Manor quits.",
      retry: null,
    };
  }
  if (relay.state === "running") {
    const n = status.relayViewers;
    return {
      tone: "ok",
      title: "Remote control is on",
      detail:
        n === 0
          ? "Your devices can connect. None connected right now."
          : `${n} device${n === 1 ? "" : "s"} connected.`,
      retry: null,
    };
  }
  if (relay.state === "starting") {
    return relay.error
      ? {
          tone: "pending",
          title: "Can't reach the relay",
          detail: `Still trying — paired devices can't reach this machine until it connects. ${relay.error}`,
          retry: null,
        }
      : {
          tone: "pending",
          title: "Turning on…",
          detail: "Paired devices can reach this machine once it connects.",
          retry: null,
        };
  }
  return {
    tone: "bad",
    title: "Can't reach the relay",
    detail: relay.error ?? "The relay connection failed.",
    retry: "Try again",
  };
}

const DOT_CLASS: Record<StatusView["tone"], string> = {
  off: "",
  ok: styles.remoteDotOk,
  pending: styles.remoteDotPending,
  bad: styles.remoteDotBad,
};

function StatusCard(props: {
  status: RemoteControlStatus;
  locked: boolean;
  onToggle: (checked: boolean) => void;
  onRetry: () => void;
}) {
  const { status, locked } = props;
  const view = describe(status);
  const live = status.relay.state === "running" && status.enabled;

  return (
    <div
      data-settings-section="remote-relay"
      data-testid="remote-relay-card"
      tabIndex={-1}
      className={`${styles.remoteStatusCard} ${live ? styles.remoteStatusLive : ""}`}
    >
      <div className={styles.remoteStatusHeader}>
        <span className={`${styles.remoteDot} ${DOT_CLASS[view.tone]}`} />
        <div className={styles.remoteStatusText}>
          <div className={styles.remoteStatusTitle}>{view.title}</div>
          <div className={styles.remoteStatusDetail}>{view.detail}</div>
        </div>
        <Row gap="xs" align="center" className={styles.remoteStatusActions}>
          {view.retry && (
            <Button
              data-testid="remote-relay-retry"
              variant="secondary"
              size="sm"
              disabled={locked}
              onClick={props.onRetry}
            >
              {view.retry}
            </Button>
          )}
          <Switch
            data-testid="remote-control-switch"
            aria-label="Remote control"
            checked={isOn(status)}
            disabled={locked}
            onCheckedChange={props.onToggle}
          />
        </Row>
      </div>

      {status.relayNotice && (
        <div className={styles.linearError} data-testid="remote-relay-notice">
          {status.relayNotice}
        </div>
      )}

      {live && status.relayAppUrl && status.devices.length > 0 && (
        <div className={styles.remoteOpenOnPhone} data-testid="remote-open-app">
          <PairingQr
            key={status.relayAppUrl}
            url={status.relayAppUrl}
            size={128}
            alt="QR code to open Manor"
          />
          <Stack gap="xs" align="flex-start" className={styles.remoteOpenOnPhoneBody}>
            <div className={styles.remoteStatusTitle}>
              Open on a paired phone
            </div>
            <div className={styles.remoteStatusDetail}>
              Scan with a device you&apos;ve already added to open Manor.
            </div>
            <CopyLinkButton
              url={status.relayAppUrl}
              testId="remote-open-app-link"
            />
          </Stack>
        </div>
      )}
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
