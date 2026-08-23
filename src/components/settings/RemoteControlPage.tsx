import { useCallback, useState } from "react";
import QRCode from "qrcode";
import Smartphone from "lucide-react/dist/esm/icons/smartphone";
import Globe from "lucide-react/dist/esm/icons/globe";
import ShieldAlert from "lucide-react/dist/esm/icons/shield-alert";
import Trash2 from "lucide-react/dist/esm/icons/trash-2";
import * as Dialog from "@radix-ui/react-dialog";

import { useRemoteControlStore } from "../../store/remote-control-store";
import { useMountEffect } from "../../hooks/useMountEffect";
import { Button } from "../ui/Button/Button";
import { Checkbox } from "../ui/Checkbox/Checkbox";
import { Input } from "../ui/Input";
import { Stack, Row } from "../ui/Layout/Layout";
import { Switch } from "../ui/Switch/Switch";
import { Tooltip } from "../ui/Tooltip/Tooltip";
import type { RemotePairResult, TunnelKind } from "../../electron.d";
import styles from "./SettingsModal/SettingsModal.module.css";
import dialogStyles from "../sidebar/dialogs.module.css";

const TUNNEL_LABEL: Record<TunnelKind, string> = {
  tailscale: "Tailscale",
  cloudflared: "Cloudflare Tunnel",
};

function formatWhen(value: number | null): string {
  if (value === null) return "never";
  return new Date(value).toLocaleString();
}

/**
 * The remote-control settings surface (ADR-161 ticket 6).
 *
 * Three separate user actions, deliberately not collapsed into one: enabling
 * the listener, starting a tunnel, and pairing a device. Each one widens
 * exposure by a different amount, and a single "turn on remote access" switch
 * would hide which of them the user actually agreed to.
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
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
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
      // Generated here rather than from an effect, and locally rather than from
      // an image service — the URL contains the device's only credential.
      const qr = result.pairingUrl
        ? await QRCode.toDataURL(result.pairingUrl, {
            margin: 1,
            width: 220,
          }).catch(() => null)
        : null;
      setQrDataUrl(qr);
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
            Check on your agents from a phone. While enabled, Manor runs a
            second, authenticated listener on this machine — reachable only over
            loopback until you start a tunnel below. It is off again every time
            Manor restarts.
          </div>
        </div>
        <Switch
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
          <Stack gap="xs">
            <div className={styles.sectionTitle}>Reachability</div>
            <div className={styles.sectionDescription}>
              The listener binds 127.0.0.1. A tunnel is what makes it reachable
              from your phone, and Manor never starts one on its own.
            </div>
            {status.port !== null && (
              <div className={styles.fieldHint}>
                Listening on <code>http://127.0.0.1:{status.port}</code> — open
                that with a pairing token in the fragment to try the client from
                this machine.
              </div>
            )}

            {running ? (
              <Stack gap="sm">
                <div className={styles.remoteExposedCard}>
                  <Globe size={14} />
                  <div>
                    <div className={styles.remoteExposedTitle}>
                      Reachable via {TUNNEL_LABEL[tunnel.kind ?? "tailscale"]}
                    </div>
                    <code className={styles.remoteUrl}>{tunnel.url}</code>
                  </div>
                </div>
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => void stopTunnel()}
                >
                  Stop tunnel
                </Button>
              </Stack>
            ) : (
              <Stack gap="sm">
                {tunnel.state === "failed" && tunnel.error && (
                  <div className={styles.linearError}>{tunnel.error}</div>
                )}
                {available.length === 0 ? (
                  <div className={styles.fieldHint}>
                    Neither <code>tailscale</code> nor <code>cloudflared</code>{" "}
                    is on your PATH. Manor does not install either one — install
                    one and reopen this page.
                  </div>
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
            )}
          </Stack>

          <Stack gap="xs">
            <div className={styles.sectionTitle}>Pair a device</div>
            <div className={styles.sectionDescription}>
              Each device gets its own token, so a device you lose can be
              revoked on its own. The token is shown once.
            </div>
            <Row gap="sm">
              <Input
                placeholder="Device name, e.g. “my phone”"
                value={label}
                maxLength={64}
                onChange={(e) => setLabel(e.target.value)}
              />
              <Button
                variant="secondary"
                disabled={label.trim().length === 0}
                onClick={() => void handlePair()}
              >
                Pair
              </Button>
            </Row>
            <label className={styles.remoteCapabilityRow}>
              <Checkbox
                checked={canSend}
                onCheckedChange={(checked) => setCanSend(checked === true)}
              />
              <span>
                Allow this device to send input
                <span className={styles.fieldHint}>
                  {" "}
                  — it can type into a live shell. Leave this off unless you
                  need it.
                </span>
              </span>
            </label>
            {!running && (
              <div className={styles.fieldHint}>
                Start a tunnel first if you want a scannable link; without one
                there is no address the phone can reach.
              </div>
            )}
            {pairError && <div className={styles.linearError}>{pairError}</div>}
          </Stack>

          <Stack gap="xs">
            <div className={styles.sectionTitle}>Paired devices</div>
            {status.devices.length === 0 ? (
              <div className={styles.placeholder}>No devices paired</div>
            ) : (
              status.devices.map((device) => (
                <div key={device.id} className={styles.remoteDeviceRow}>
                  <div>
                    <div className={styles.remoteDeviceLabel}>
                      <Smartphone size={12} />
                      <span>{device.label}</span>
                      {device.canSend && (
                        <span className={styles.remoteSendBadge}>can send</span>
                      )}
                    </div>
                    <div className={styles.fieldHint}>
                      Paired {formatWhen(device.createdAt)} · last seen{" "}
                      {formatWhen(device.lastSeenAt)}
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Revoke ${device.label}`}
                    disabled={busy}
                    onClick={() => void revoke(device.id)}
                  >
                    <Trash2 size={13} />
                  </Button>
                </div>
              ))
            )}
          </Stack>
        </>
      )}

      <TunnelConfirmDialog
        kind={confirmKind}
        canSendCount={status.devices.filter((d) => d.canSend).length}
        onCancel={() => setConfirmKind(null)}
        onConfirm={(kind) => {
          setConfirmKind(null);
          void startTunnel(kind);
        }}
      />

      <PairingResultDialog
        result={pairing}
        qrDataUrl={qrDataUrl}
        onClose={() => {
          setPairing(null);
          setQrDataUrl(null);
        }}
      />
    </Stack>
  );
}

/**
 * Starting a tunnel is an outward-facing action, so the dialog names what
 * becomes reachable and by which tool rather than asking "are you sure".
 */
function TunnelConfirmDialog(props: {
  kind: TunnelKind | null;
  canSendCount: number;
  onCancel: () => void;
  onConfirm: (kind: TunnelKind) => void;
}) {
  const { kind, canSendCount, onCancel, onConfirm } = props;
  return (
    <Dialog.Root
      open={kind !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={dialogStyles.confirmOverlay} />
        <Dialog.Content className={dialogStyles.confirmDialog}>
          <Dialog.Title className={dialogStyles.confirmTitle}>
            Make this machine reachable via{" "}
            {kind ? TUNNEL_LABEL[kind] : "a tunnel"}?
          </Dialog.Title>
          <Dialog.Description className={dialogStyles.confirmDescription}>
            Paired devices will be able to read your session list, your agent
            statuses, and the full scrollback of any session — which routinely
            contains API keys and source code.
            {canSendCount > 0
              ? ` ${canSendCount} paired device${canSendCount === 1 ? "" : "s"} can also type into a live shell.`
              : " No paired device can type into a session."}
            {kind === "cloudflared"
              ? " A Cloudflare quick tunnel is public: the pairing token is the only thing protecting it."
              : " Only devices on your tailnet can reach the address at all."}{" "}
            The tunnel stops when Manor quits.
          </Dialog.Description>
          <div className={dialogStyles.confirmActions}>
            <Button variant="secondary" onClick={onCancel}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                if (kind) onConfirm(kind);
              }}
            >
              Start tunnel
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** The one moment the raw token exists in the UI. It is not recoverable after. */
function PairingResultDialog(props: {
  result: RemotePairResult | null;
  qrDataUrl: string | null;
  onClose: () => void;
}) {
  const { result, qrDataUrl, onClose } = props;
  const [copied, setCopied] = useState<string | null>(null);

  const copy = (what: string, value: string) => {
    void navigator.clipboard.writeText(value);
    setCopied(what);
  };

  return (
    <Dialog.Root
      open={result !== null}
      onOpenChange={(open) => {
        if (!open) {
          setCopied(null);
          onClose();
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={dialogStyles.confirmOverlay} />
        <Dialog.Content className={dialogStyles.confirmDialog}>
          <Dialog.Title className={dialogStyles.confirmTitle}>
            {result?.device.label} paired
          </Dialog.Title>
          <Dialog.Description className={dialogStyles.confirmDescription}>
            This token is shown once and cannot be retrieved again. If you lose
            it, revoke the device and pair it afresh.
          </Dialog.Description>

          {qrDataUrl && (
            <img
              className={styles.remoteQr}
              src={qrDataUrl}
              alt="Pairing QR code"
            />
          )}

          {result?.pairingUrl ? (
            <Stack gap="xs">
              <code className={styles.remoteToken}>{result.pairingUrl}</code>
              <Button
                variant="secondary"
                onClick={() => copy("link", result.pairingUrl!)}
              >
                {copied === "link" ? "Copied" : "Copy link"}
              </Button>
            </Stack>
          ) : (
            <div className={styles.fieldHint}>
              No tunnel is running, so there is no address to scan yet. Copy the
              token, start a tunnel, and open{" "}
              <code>https://&lt;your tunnel host&gt;/#&lt;token&gt;</code> on
              the device.
            </div>
          )}

          <Stack gap="xs">
            <code className={styles.remoteToken}>{result?.rawToken}</code>
            <Button
              variant="secondary"
              onClick={() => result && copy("token", result.rawToken)}
            >
              {copied === "token" ? "Copied" : "Copy token"}
            </Button>
          </Stack>

          <div className={dialogStyles.confirmActions}>
            <Button variant="secondary" onClick={onClose}>
              Done
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
