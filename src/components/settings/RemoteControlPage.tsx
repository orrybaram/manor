import { useCallback, useState } from "react";
import Smartphone from "lucide-react/dist/esm/icons/smartphone";
import Laptop from "lucide-react/dist/esm/icons/laptop";
import Globe from "lucide-react/dist/esm/icons/globe";
import ShieldAlert from "lucide-react/dist/esm/icons/shield-alert";
import Trash2 from "lucide-react/dist/esm/icons/trash-2";

import { useRemoteControlStore } from "../../store/remote-control-store";
import { useMountEffect } from "../../hooks/useMountEffect";
import { Button } from "../ui/Button/Button";
import { Checkbox } from "../ui/Checkbox/Checkbox";
import { Input } from "../ui/Input";
import { Stack, Row } from "../ui/Layout/Layout";
import { Switch } from "../ui/Switch/Switch";
import { Tooltip } from "../ui/Tooltip/Tooltip";
import { CopyField } from "./CopyField";
import { relativeShort } from "../../utils/relative-time";
import {
  PairingResultDialog,
  TunnelConfirmDialog,
} from "./RemoteControlDialogs";
import type {
  RemoteDeviceInfo,
  RemotePairResult,
  TunnelKind,
} from "../../electron.d";
import styles from "./SettingsModal/SettingsModal.module.css";

const TUNNEL_LABEL: Record<TunnelKind, string> = {
  tailscale: "Tailscale",
  cloudflared: "Cloudflare Tunnel",
};

/**
 * The remote-control settings surface (ADR-161 ticket 6).
 *
 * Three separate user actions, deliberately not collapsed into one: enabling
 * the listener, pairing a device, and starting a tunnel. Each widens exposure
 * by a different amount, and a single "turn on remote access" switch would
 * hide which of them the user actually agreed to.
 *
 * The page is ordered by how often you touch it — what is reachable right now,
 * then your devices, then the tunnel — and it states the current exposure as a
 * fact rather than leaving it to be inferred from which controls are showing.
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

  const [label, setLabel] = useState("");
  const [canSend, setCanSend] = useState(false);
  const [pairing, setPairing] = useState<RemotePairResult | null>(null);
  const [pairError, setPairError] = useState<string | null>(null);
  const [confirmKind, setConfirmKind] = useState<TunnelKind | null>(null);

  useMountEffect(() => {
    void refreshDetection();
  });

  const tunnel = status.tunnel;
  const running = tunnel.state === "running";
  const available = (["tailscale", "cloudflared"] as const).filter(
    (kind) => status.detected[kind],
  );

  const handlePair = useCallback(async () => {
    setPairError(null);
    try {
      const result = await window.electronAPI.remoteControl.pair(
        label.trim(),
        canSend,
      );
      setPairing(result);
      setLabel("");
      setCanSend(false);
    } catch (err) {
      setPairError(err instanceof Error ? err.message : String(err));
    }
  }, [label, canSend]);

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
          disabled={busy || !status.encryptionAvailable}
          onCheckedChange={(checked) => void setEnabled(checked)}
        />
      </div>

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
          <ExposureCard
            port={status.port}
            listeners={status.listeners}
            tunnelUrl={running ? tunnel.url : null}
            tunnelKind={running ? (tunnel.kind ?? null) : null}
          />

          <Stack gap="xs">
            <div className={styles.sectionTitle}>Devices</div>
            <div className={styles.sectionDescription}>
              Every device gets its own token, shown once. Revoking one takes
              effect on its next request.
            </div>

            <Row gap="sm">
              <Input
                data-testid="remote-pair-label"
                placeholder="Device name, e.g. “my phone”"
                value={label}
                maxLength={64}
                onChange={(e) => setLabel(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && label.trim()) void handlePair();
                }}
              />
              <Button
                data-testid="remote-pair-submit"
                variant="secondary"
                disabled={busy || label.trim().length === 0}
                onClick={() => void handlePair()}
              >
                Pair
              </Button>
            </Row>
            <label className={styles.remoteCapabilityRow}>
              <Checkbox
                data-testid="remote-pair-can-send"
                checked={canSend}
                onCheckedChange={(checked) => setCanSend(checked === true)}
              />
              <span>
                Let this device send input
                <span className={styles.fieldHint}>
                  It can type into a live shell. Leave off unless you need it.
                </span>
              </span>
            </label>
            {pairError && <div className={styles.linearError}>{pairError}</div>}

            {status.devices.length === 0 ? (
              <div className={styles.placeholder}>No devices paired yet</div>
            ) : (
              <div className={styles.remoteDeviceList}>
                {status.devices.map((device) => (
                  <DeviceRow
                    key={device.id}
                    device={device}
                    busy={busy}
                    onRevoke={() => void revoke(device.id)}
                  />
                ))}
              </div>
            )}
          </Stack>

          <Stack gap="xs">
            <div className={styles.sectionTitle}>Tunnel</div>
            <div className={styles.sectionDescription}>
              The listener binds 127.0.0.1. A tunnel is what lets your phone
              reach it, and Manor never starts one on its own.
            </div>

            {tunnel.state === "failed" && tunnel.error && (
              <div className={styles.linearError}>{tunnel.error}</div>
            )}

            {running ? (
              <Row gap="sm">
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => void stopTunnel()}
                >
                  Stop tunnel
                </Button>
                <span className={styles.fieldHint}>
                  It also stops when Manor quits.
                </span>
              </Row>
            ) : available.length === 0 ? (
              <NoTunnelTools />
            ) : (
              <Row gap="sm">
                {available.map((kind) => (
                  <Tooltip
                    key={kind}
                    label={
                      kind === "tailscale"
                        ? "Preferred: your device is already authenticated at the network layer, so the pairing token is a second factor rather than the only one."
                        : "A public quick tunnel. The pairing token is the only thing between the internet and your sessions."
                    }
                  >
                    <Button
                      variant="secondary"
                      disabled={busy || tunnel.state === "starting"}
                      onClick={() => setConfirmKind(kind)}
                    >
                      {tunnel.state === "starting"
                        ? "Starting…"
                        : `Start ${TUNNEL_LABEL[kind]}`}
                    </Button>
                  </Tooltip>
                ))}
              </Row>
            )}
          </Stack>
        </>
      )}

      <TunnelConfirmDialog
        kind={confirmKind}
        kindLabel={confirmKind ? TUNNEL_LABEL[confirmKind] : null}
        canSendCount={status.devices.filter((d) => d.canSend).length}
        onCancel={() => setConfirmKind(null)}
        onConfirm={(kind) => {
          setConfirmKind(null);
          void startTunnel(kind);
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
 * What is reachable, right now, in one line — the question the rest of the
 * page is in service of. Loopback and tunnel are different enough facts to
 * deserve different words and a different colour, rather than a control the
 * reader has to decode.
 */
function ExposureCard(props: {
  port: number | null;
  listeners: number;
  tunnelUrl: string | null;
  tunnelKind: TunnelKind | null;
}) {
  const { port, listeners, tunnelUrl, tunnelKind } = props;
  const exposed = tunnelUrl !== null;

  const watching =
    listeners === 0
      ? "Nothing connected"
      : `${listeners} device${listeners === 1 ? "" : "s"} connected`;

  return (
    <div
      className={`${styles.remoteExposureCard} ${exposed ? styles.remoteExposureOpen : ""}`}
    >
      <div className={styles.remoteExposureIcon}>
        {exposed ? <Globe size={15} /> : <Laptop size={15} />}
      </div>
      <Stack gap="xs" className={styles.remoteExposureBody}>
        <div className={styles.remoteExposureTitle}>
          {exposed
            ? `Reachable over ${TUNNEL_LABEL[tunnelKind ?? "tailscale"]}`
            : "Reachable from this machine only"}
        </div>
        {exposed ? (
          <CopyField value={tunnelUrl} label="address" />
        ) : port !== null ? (
          <CopyField
            value={`http://127.0.0.1:${port}`}
            label="address"
            testId="remote-listener-address"
          />
        ) : null}
        <div className={styles.fieldHint}>{watching}</div>
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
          {device.canSend && (
            <span className={styles.remoteSendBadge}>can send</span>
          )}
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

/** Neither binary is installed. Say what to do about it, not just what is wrong. */
function NoTunnelTools() {
  return (
    <Stack gap="xs">
      <div className={styles.fieldHint}>
        Manor does not install either tool. Install one, then reopen this page.
      </div>
      <CopyField value="brew install cloudflared" label="install command" />
      <CopyField
        value="brew install --cask tailscale"
        label="install command"
      />
    </Stack>
  );
}
