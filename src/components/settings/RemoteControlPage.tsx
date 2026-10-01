import { useCallback, useState, type ReactNode } from "react";
import Smartphone from "lucide-react/dist/esm/icons/smartphone";
import Laptop from "lucide-react/dist/esm/icons/laptop";
import Globe from "lucide-react/dist/esm/icons/globe";
import ShieldAlert from "lucide-react/dist/esm/icons/shield-alert";
import Trash2 from "lucide-react/dist/esm/icons/trash-2";

import { useRemoteControlStore } from "../../store/remote-control-store";
import { useMountEffect } from "../../hooks/useMountEffect";
import { Button } from "../ui/Button/Button";
import { EmojiInput } from "../ui/EmojiAutocomplete";
import { Stack, Row } from "../ui/Layout/Layout";
import { Switch } from "../ui/Switch/Switch";
import { ToggleGroup } from "../ui/ToggleGroup";
import { Tooltip } from "../ui/Tooltip/Tooltip";
import { CopyField } from "./CopyField";
import { MiniTerminal } from "../ui/MiniTerminal";
import { Link } from "../ui/Link/Link";
import { relativeShort } from "../../utils/relative-time";
import {
  PairingResultDialog,
  TunnelConfirmDialog,
} from "./RemoteControlDialogs";
import type {
  RemoteCapability,
  RemoteDeviceInfo,
  RemotePairResult,
  TailnetInfo,
  TunnelStatus,
} from "../../electron.d";
import { SectionTitle } from "./SectionTitle";
import { isWebApp } from "../../lib/platform";
import styles from "./SettingsModal/SettingsModal.module.css";

/**
 * The Tailscale app, not the `tailscale` formula: the app runs its own daemon
 * as the user, so `tailscale serve` works without sudo, and signing in is a
 * window rather than a URL in a terminal. Its CLI lives inside the bundle,
 * where main looks for it when `tailscale` is not on PATH.
 */
const TAILSCALE_INSTALL_COMMAND =
  "brew install --cask tailscale-app && open -a Tailscale";

/**
 * The three tiers, as a person picks them (ADR-178 D3). Named for what the
 * device gets to *do* rather than for the mechanism, and ordered by how much
 * of the machine that is. `read` is first because it is the default.
 */
const CAPABILITY_OPTIONS: {
  value: RemoteCapability;
  label: string;
}[] = [
  { value: "read", label: "Watch" },
  { value: "send", label: "Reply" },
  { value: "full", label: "Everything" },
];

/** One sentence per tier, shown under the picker for whichever is selected. */
const CAPABILITY_HINT: Record<RemoteCapability, string> = {
  read: "It can see your sessions, their statuses and their full scrollback. It cannot type.",
  send: "It can type into a live shell. Leave off unless you need it.",
  full: "This device can do anything the desktop app can, including removing workspaces.",
};

/** Short badge for a device row. `read` gets none — it is the baseline. */
const CAPABILITY_BADGE: Record<RemoteCapability, string | null> = {
  read: null,
  send: "can send",
  full: "everything",
};

/**
 * The remote-control settings surface (ADR-161 ticket 6).
 *
 * Three separate user actions, deliberately not collapsed into one: enabling
 * the listener, pairing a device, and starting a tunnel. Each widens exposure
 * by a different amount, and a single "turn on remote access" switch would
 * hide which of them the user actually agreed to.
 *
 * Once the listener is on, the tunnel is the main call to action: it sits on
 * the card that states what is reachable right now, above the devices. The
 * card states the exposure as a fact rather than leaving it to be inferred
 * from which controls are showing.
 */
export function RemoteControlPage() {
  const status = useRemoteControlStore((s) => s.status);
  const busy = useRemoteControlStore((s) => s.busy);
  const error = useRemoteControlStore((s) => s.error);
  const setEnabled = useRemoteControlStore((s) => s.setEnabled);
  const startTunnel = useRemoteControlStore((s) => s.startTunnel);
  const stopTunnel = useRemoteControlStore((s) => s.stopTunnel);
  const revoke = useRemoteControlStore((s) => s.revoke);
  const refreshDetection = useRemoteControlStore((s) => s.refreshDetection);
  const pair = useRemoteControlStore((s) => s.pair);

  const [label, setLabel] = useState("");
  // Never `full` by default, and never sticky between pairings: the widest
  // tier has to be chosen every time, by someone who has just read the
  // sentence under it.
  const [capability, setCapability] = useState<RemoteCapability>("read");
  const [pairing, setPairing] = useState<RemotePairResult | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  useMountEffect(() => {
    void refreshDetection();
  });

  // `remoteControl.setEnabled/pair/revoke/startTunnel/stopTunnel` are
  // `localOnly` (ADR-180 D3) — a browser can read this page's status but
  // can't touch the switch, pairing form or tunnel controls.
  const webApp = isWebApp();
  const locked = webApp || busy || !status.encryptionAvailable;

  const tunnel = status.tunnel;
  // A failed start rejects *and* lands in the tunnel status; the card already
  // shows the latter, so don't say it twice at the top of the page.
  const pageError =
    error &&
    tunnel.state === "failed" &&
    tunnel.error &&
    error.includes(tunnel.error)
      ? null
      : error;

  const handlePair = useCallback(async () => {
    const result = await pair(label.trim(), capability);
    if (result) {
      setPairing(result);
      setLabel("");
      setCapability("read");
    }
  }, [label, capability, pair]);

  return (
    <Stack className={styles.pageContent}>
      <div className={styles.notifToggleCard}>
        <div>
          <div className={styles.notifToggleTitle}>Remote control</div>
          <div className={styles.notifToggleDesc}>
            Check on your agents from your phone. Manor runs a second,
            authenticated listener while this is on, and turns it off again
            every time it restarts.
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
          and tunnel controls are read-only here.
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

      {pageError && <div className={styles.linearError}>{pageError}</div>}

      {status.enabled && (
        <>
          <ConnectionCard
            port={status.port}
            listeners={status.listeners}
            tunnel={tunnel}
            installed={status.installed}
            tailnet={status.tailnet}
            locked={locked}
            onStart={() => setConfirmOpen(true)}
            onStop={() => void stopTunnel()}
            onRecheck={() => void refreshDetection()}
          />

          <Stack gap="xs">
            <SectionTitle id="remote-devices">Devices</SectionTitle>
            <div className={styles.sectionDescription}>
              Every device gets its own token, shown once. Revoking one takes
              effect on its next request.
            </div>

            <Row gap="sm">
              <EmojiInput
                data-testid="remote-pair-label"
                placeholder="Device name, e.g. “my phone”"
                value={label}
                maxLength={64}
                disabled={locked}
                onChange={(e) => setLabel(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && label.trim()) void handlePair();
                }}
              />
              <Button
                data-testid="remote-pair-submit"
                variant="secondary"
                disabled={locked || label.trim().length === 0}
                onClick={() => void handlePair()}
              >
                Pair
              </Button>
            </Row>
            <div
              className={styles.remoteCapabilityRow}
              data-testid="remote-pair-capability"
            >
              <ToggleGroup
                size="sm"
                value={capability}
                onChange={setCapability}
                options={CAPABILITY_OPTIONS}
              />
              {capability === "full" ? (
                <div className={styles.remoteWarning}>
                  <ShieldAlert size={14} />
                  <span>{CAPABILITY_HINT.full}</span>
                </div>
              ) : (
                <span className={styles.fieldHint}>
                  {CAPABILITY_HINT[capability]}
                </span>
              )}
            </div>
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

      <TunnelConfirmDialog
        open={confirmOpen}
        capabilityCounts={{
          send: status.devices.filter((d) => d.capability === "send").length,
          full: status.devices.filter((d) => d.capability === "full").length,
        }}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => {
          setConfirmOpen(false);
          void startTunnel();
        }}
      />

      <PairingResultDialog
        result={pairing}
        port={status.port}
        onClose={() => setPairing(null)}
      />
    </Stack>
  );
}

/**
 * What is reachable right now, and the one thing to do about it.
 *
 * The tunnel is the step that makes remote control useful at all — without it
 * the listener is loopback-only — so starting it is the page's main action and
 * lives on the card that states the exposure, rather than in a section below
 * the devices. Loopback and tunnel are different enough facts to get different
 * words and a different colour.
 */
function ConnectionCard(props: {
  port: number | null;
  listeners: number;
  tunnel: TunnelStatus;
  /** Whether `tailscale` is on PATH. */
  installed: boolean;
  tailnet: TailnetInfo | null;
  locked: boolean;
  onStart: () => void;
  onStop: () => void;
  onRecheck: () => void;
}) {
  const { port, listeners, tunnel, installed, locked } = props;
  const running = tunnel.state === "running" && tunnel.url !== null;
  const starting = tunnel.state === "starting";
  const { onRecheck } = props;

  // The mini terminal the install runs in. Its session id is fresh per
  // attempt so a retry never attaches to the previous run's PTY.
  const [installSession, setInstallSession] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const startInstall = () => {
    setInstallSession(`tailscale-install-${Date.now()}`);
    setInstalling(true);
  };
  // Whatever the exit code, ask again. A failed install leaves the card in
  // the "not installed" state, with the terminal still showing why and the
  // Install button back for a retry.
  const handleInstallExit = useCallback(() => {
    setInstalling(false);
    onRecheck();
  }, [onRecheck]);

  const watching =
    listeners === 0
      ? "Nothing connected"
      : `${listeners} device${listeners === 1 ? "" : "s"} connected`;

  let title: string;
  let description: ReactNode;
  let action: ReactNode;
  if (starting && tunnel.actionUrl) {
    // `tailscale serve` is up but waiting on the admin console. It polls and
    // carries on by itself, so the card just has to hand over the link.
    title = "Enable Tailscale Serve for your tailnet";
    description = (
      <>
        Tailscale needs Serve turned on once for your tailnet.{" "}
        <Link href={tunnel.actionUrl}>Enable it in the admin console</Link> —
        the tunnel starts by itself when you&apos;re done.
      </>
    );
    // Not `locked`: the start call is still in flight, which is what sets
    // `busy`, and Cancel has to work during exactly that.
    action = (
      <Button variant="secondary" onClick={props.onStop}>
        Cancel
      </Button>
    );
  } else if (running) {
    title = "Reachable over Tailscale";
    description = null;
    action = (
      <Button variant="secondary" disabled={locked} onClick={props.onStop}>
        Stop tunnel
      </Button>
    );
  } else if (!installed) {
    title = "Install Tailscale to reach Manor from your phone";
    description = installing
      ? "Installing the Tailscale app. Sign in to it when it opens."
      : "Manor installs the Tailscale app with Homebrew, then opens it so you can sign in.";
    action = installing ? null : (
      <Row gap="xs">
        <Button variant="ghost" disabled={locked} onClick={props.onRecheck}>
          Check again
        </Button>
        <Button
          data-testid="remote-tailscale-install"
          variant="primary"
          disabled={locked}
          onClick={startInstall}
        >
          Install
        </Button>
      </Row>
    );
  } else {
    title = "Reachable from this machine only";
    description =
      "Start a tunnel to reach Manor from your phone. Tailscale must be signed in; only devices on your tailnet can connect, and the tunnel stops when Manor quits.";
    action = (
      <Button
        data-testid="remote-tunnel-start"
        variant="primary"
        disabled={locked || starting}
        onClick={props.onStart}
      >
        {starting
          ? "Starting…"
          : tunnel.state === "failed"
            ? "Try again"
            : "Start tunnel"}
      </Button>
    );
  }

  return (
    <div
      // The settings-search anchor for "Tunnel" — the card is that section now.
      data-settings-section="remote-tunnel"
      tabIndex={-1}
      className={`${styles.remoteExposureCard} ${running ? styles.remoteExposureOpen : ""}`}
    >
      <div className={styles.remoteExposureIcon}>
        {running ? <Globe size={15} /> : <Laptop size={15} />}
      </div>
      <Stack gap="xs" className={styles.remoteExposureBody}>
        <div className={styles.remoteExposureHeader}>
          <div className={styles.remoteExposureTitle}>{title}</div>
          {action}
        </div>
        {description && <div className={styles.fieldHint}>{description}</div>}
        {tunnel.state === "failed" && tunnel.error && (
          <div className={styles.linearError}>{tunnel.error}</div>
        )}
        {running && <CopyField value={tunnel.url ?? ""} label="address" />}
        {running && props.tailnet && <TailnetDevices tailnet={props.tailnet} />}
        {installSession !== null && !installed && (
          <MiniTerminal
            key={installSession}
            sessionId={installSession}
            cwd={null}
            command={TAILSCALE_INSTALL_COMMAND}
            interactive
            exitOnComplete
            onExit={handleInstallExit}
            className={styles.remoteInstallTerminal}
          />
        )}
        {!running && port !== null && (
          <CopyField
            value={`http://127.0.0.1:${port}`}
            label="address"
            testId="remote-listener-address"
          />
        )}
        <div className={styles.fieldHint}>{watching}</div>
      </Stack>
    </div>
  );
}

/**
 * A `*.ts.net` address opens only on devices in the tailnet, so a phone that
 * has not joined gets "site can't be reached" with nothing to say why. Name
 * that case on the card, with the account to sign in as; otherwise list who
 * can reach the address.
 */
function TailnetDevices(props: { tailnet: TailnetInfo }) {
  const { account, peers } = props.tailnet;
  if (peers.length === 0) {
    return (
      <div
        className={styles.remoteTailnetNote}
        data-testid="remote-tailnet-empty"
      >
        Only this machine is on your tailnet, so your phone can&apos;t open this
        address yet.{" "}
        <Link href="https://tailscale.com/download">Install Tailscale</Link> on
        your phone and sign in
        {account ? (
          <>
            {" "}
            as <strong>{account}</strong>
          </>
        ) : (
          " with the same account"
        )}
        . This updates when it joins.
      </div>
    );
  }
  return (
    <div className={styles.fieldHint}>
      On your tailnet:{" "}
      {peers
        .map((peer) => (peer.online ? peer.name : `${peer.name} (offline)`))
        .join(", ")}
    </div>
  );
}

function DeviceRow(props: {
  device: RemoteDeviceInfo;
  busy: boolean;
  onRevoke: () => void;
}) {
  const { device, busy, onRevoke } = props;
  const badge = CAPABILITY_BADGE[device.capability];
  return (
    <div data-testid="remote-device-row" className={styles.remoteDeviceRow}>
      <Smartphone size={14} className={styles.remoteDeviceIcon} />
      <div className={styles.remoteDeviceBody}>
        <div className={styles.remoteDeviceLabel}>
          <span>{device.label}</span>
          {badge && <span className={styles.remoteSendBadge}>{badge}</span>}
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
