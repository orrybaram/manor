import { useState } from "react";
import QRCode from "qrcode";
import * as Dialog from "@radix-ui/react-dialog";

import { useMountEffect } from "../../hooks/useMountEffect";
import { Button } from "../ui/Button/Button";
import { CopyField } from "./CopyField";
import type { RemotePairResult } from "../../electron.d";
import styles from "./SettingsModal/SettingsModal.module.css";
import dialogStyles from "../sidebar/dialogs.module.css";

/**
 * Starting the relay is an outward-facing action, so the dialog names what
 * becomes reachable rather than asking "are you sure".
 */
export function RelayConfirmDialog(props: {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { open, onCancel, onConfirm } = props;
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={dialogStyles.confirmOverlay} />
        <Dialog.Content
          data-testid="remote-relay-confirm"
          className={dialogStyles.confirmDialog}
        >
          <Dialog.Title className={dialogStyles.confirmTitle}>
            Make this machine reachable through the Manor relay?
          </Dialog.Title>
          <Dialog.Description className={dialogStyles.confirmDescription}>
            Paired devices can do everything the desktop app can, including
            reading your sessions and their scrollback (which routinely contains
            API keys and source code), typing into terminals and removing
            workspaces. Everything between this machine and those devices is
            end-to-end encrypted, so the relay itself cannot read any of it. The
            relay stops when Manor quits.
          </Dialog.Description>
          <div className={dialogStyles.confirmActions}>
            <Button variant="secondary" onClick={onCancel}>
              Cancel
            </Button>
            <Button variant="primary" onClick={onConfirm}>
              Start relay
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Resetting the address kills every link, so say so before doing it. */
export function ResetRelayDialog(props: {
  open: boolean;
  devices: number;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { open, devices, onCancel, onConfirm } = props;
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={dialogStyles.confirmOverlay} />
        <Dialog.Content
          data-testid="remote-relay-reset-confirm"
          className={dialogStyles.confirmDialog}
        >
          <Dialog.Title className={dialogStyles.confirmTitle}>
            Reset the relay address?
          </Dialog.Title>
          <Dialog.Description className={dialogStyles.confirmDescription}>
            This stops the relay and gives this machine a new address. Every
            paired device{devices > 0 ? ` (${devices} now)` : ""} is
            disconnected, revoked, and will need to be paired again.
          </Dialog.Description>
          <div className={dialogStyles.confirmActions}>
            <Button variant="secondary" onClick={onCancel}>
              Cancel
            </Button>
            <Button variant="danger" onClick={onConfirm}>
              Reset address
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * The QR code for one link. Keyed by the link at the call site, so a new link
 * is a new component: the code is generated once on mount, a stale one can
 * never be shown for a different link, and nothing needs clearing.
 */
function PairingQr(props: { url: string }) {
  const { url } = props;

  const [data, setData] = useState<string | null>(null);
  useMountEffect(() => {
    let live = true;
    void QRCode.toDataURL(url, { margin: 1, width: 220 })
      .then((encoded) => {
        if (live) setData(encoded);
      })
      .catch(() => {
        // No code, just the link below it.
      });
    return () => {
      live = false;
    };
  });
  if (!data) return null;
  return <img className={styles.remoteQr} src={data} alt="Pairing QR code" />;
}

/**
 * The one moment the raw token exists in the UI.
 *
 * What the device needs is a *link* — the token rides in its fragment — so the
 * link is what this leads with, with its QR code. Every pairing is a relay
 * link: the relay is the only road to this machine (ADR-207).
 *
 * The link always has an address; what it may lack is a running relay,
 * and an iPhone needs one more step for notifications (ADR-206 D7) — both
 * said here, where the link is being handed over.
 */
export function PairingResultDialog(props: {
  result: RemotePairResult | null;
  /** Whether the relay is connected, so the link reaches this machine. */
  relayRunning: boolean;
  onClose: () => void;
}) {
  const { result, relayRunning, onClose } = props;

  const pairingUrl = result?.pairingUrl ?? null;

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
            {pairingUrl && <PairingQr key={pairingUrl} url={pairingUrl} />}

            <div>
              {pairingUrl && (
                <>
                  <div className={styles.fieldLabel}>Link</div>
                  <CopyField
                    value={pairingUrl}
                    label="link"
                    testId="remote-pairing-link"
                  />
                </>
              )}
              {!relayRunning && (
                <div
                  className={styles.fieldHint}
                  data-testid="remote-pairing-relay-stopped"
                >
                  The relay isn&apos;t connected, so this link won&apos;t reach
                  this machine until it is. Start the relay from the card above.
                </div>
              )}
              <div
                className={styles.fieldHint}
                data-testid="remote-pairing-ios-hint"
              >
                On an iPhone or iPad, notifications need the page on the Home
                Screen: open the link in Safari, then Share → Add to Home
                Screen, and open Manor from there.
              </div>
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
