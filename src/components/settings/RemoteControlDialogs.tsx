import { useEffect, useState } from "react";
import QRCode from "qrcode";
import * as Dialog from "@radix-ui/react-dialog";

import { Button } from "../ui/Button/Button";
import { CopyField } from "./CopyField";
import type { RemotePairResult, TunnelKind } from "../../electron.d";
import styles from "./SettingsModal/SettingsModal.module.css";
import dialogStyles from "../sidebar/dialogs.module.css";

/**
 * Starting a tunnel is an outward-facing action, so the dialog names what
 * becomes reachable and by which tool rather than asking "are you sure".
 */
export function TunnelConfirmDialog(props: {
  kind: TunnelKind | null;
  /** How the tool is written for a reader: "Tailscale", "Cloudflare Tunnel". */
  kindLabel: string | null;
  canSendCount: number;
  onCancel: () => void;
  onConfirm: (kind: TunnelKind) => void;
}) {
  const { kind, kindLabel, canSendCount, onCancel, onConfirm } = props;
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
            Make this machine reachable via {kindLabel ?? "a tunnel"}?
          </Dialog.Title>
          <Dialog.Description className={dialogStyles.confirmDescription}>
            Paired devices will be able to read your sessions, their statuses,
            and the full scrollback of any of them — which routinely contains
            API keys and source code.
            {canSendCount > 0
              ? ` ${canSendCount} of them can also type into a live shell.`
              : " None of them can type into a session."}
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

/**
 * The one moment the raw token exists in the UI.
 *
 * What the device needs is a *link* — the token rides in its fragment — so the
 * link is what this leads with, and it is offered whether or not a tunnel is
 * running: without one it points at loopback, which still works in a browser
 * on this machine and is the fastest way to see what the phone will see. The
 * QR code only appears for an address a phone can actually reach.
 */
export function PairingResultDialog(props: {
  result: RemotePairResult | null;
  /** Loopback address of the listener, for the local link. */
  port: number | null;
  onClose: () => void;
}) {
  const { result, port, onClose } = props;
  // Keyed by the URL it encodes, so a stale code can never be shown for a new
  // link, and nothing has to be cleared synchronously when the link goes away.
  const [qr, setQr] = useState<{ url: string; data: string } | null>(null);

  const tunnelUrl = result?.pairingUrl ?? null;
  const localUrl =
    result && port !== null
      ? `http://127.0.0.1:${port}/#${result.rawToken}`
      : null;

  useEffect(() => {
    if (!tunnelUrl) return;
    let live = true;
    void QRCode.toDataURL(tunnelUrl, { margin: 1, width: 220 })
      .then((data) => {
        if (live) setQr({ url: tunnelUrl, data });
      })
      .catch(() => {
        // No code, just the link below it.
      });
    return () => {
      live = false;
    };
  }, [tunnelUrl]);

  return (
    <Dialog.Root
      open={result !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={dialogStyles.confirmOverlay} />
        <Dialog.Content
          data-testid="remote-pairing-dialog"
          className={dialogStyles.confirmDialog}
        >
          <Dialog.Title className={dialogStyles.confirmTitle}>
            {result?.device.label} is paired
          </Dialog.Title>
          <Dialog.Description className={dialogStyles.confirmDescription}>
            Open this link on the device. It is shown once — if you lose it,
            revoke the device and pair it again.
          </Dialog.Description>

          <div className={styles.remotePairingBody}>
            {qr?.url === tunnelUrl && (
              <img
                className={styles.remoteQr}
                src={qr.data}
                alt="Pairing QR code"
              />
            )}

            <div>
              <div className={styles.fieldLabel}>
                {tunnelUrl ? "Link" : "Link (this machine only)"}
              </div>
              <CopyField value={tunnelUrl ?? localUrl ?? ""} label="link" />
              {!tunnelUrl && (
                <div className={styles.fieldHint}>
                  No tunnel is running, so this address only works in a browser
                  here. Start a tunnel and pair again for a link your phone can
                  open.
                </div>
              )}
            </div>

            <div>
              <div className={styles.fieldLabel}>Token</div>
              <CopyField
                value={result?.rawToken ?? ""}
                label="token"
                testId="remote-pairing-token"
              />
            </div>
          </div>

          <div className={dialogStyles.confirmActions}>
            <Button
              data-testid="remote-pairing-done"
              variant="secondary"
              onClick={onClose}
            >
              Done
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
