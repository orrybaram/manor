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
 * What the paired devices will be able to do, in one sentence, counted by
 * tier (ADR-178 D3).
 *
 * A tier with nobody in it is not mentioned: "0 of them can do anything the
 * desktop app can" is noise in a dialog whose whole job is to say what is
 * actually about to become reachable.
 */
function capabilitySentence(counts: { send: number; full: number }): string {
  const clauses: string[] = [];
  if (counts.send > 0)
    clauses.push(`${counts.send} of them can also type into a live shell`);
  if (counts.full > 0)
    clauses.push(
      `${counts.full} can do anything the desktop app can, including removing workspaces`,
    );
  if (clauses.length === 0) return " None of them can type into a session.";
  return ` ${clauses.join(", and ")}.`;
}

/**
 * Starting a tunnel is an outward-facing action, so the dialog names what
 * becomes reachable rather than asking "are you sure".
 */
export function TunnelConfirmDialog(props: {
  open: boolean;
  /** Paired devices above the read tier, counted per tier. */
  capabilityCounts: { send: number; full: number };
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { open, capabilityCounts, onCancel, onConfirm } = props;
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={dialogStyles.confirmOverlay} />
        <Dialog.Content className={dialogStyles.confirmDialog}>
          <Dialog.Title className={dialogStyles.confirmTitle}>
            Make this machine reachable over Tailscale?
          </Dialog.Title>
          <Dialog.Description className={dialogStyles.confirmDescription}>
            Paired devices will be able to read your sessions, their statuses,
            and the full scrollback of any of them — which routinely contains
            API keys and source code.
            {capabilitySentence(capabilityCounts)} Only devices on your tailnet
            can reach the address at all. The tunnel stops when Manor quits.
          </Dialog.Description>
          <div className={dialogStyles.confirmActions}>
            <Button variant="secondary" onClick={onCancel}>
              Cancel
            </Button>
            <Button variant="primary" onClick={onConfirm}>
              Start tunnel
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * Starting the relay gets the same explicit confirmation as the tunnel: what
 * becomes reachable, and the one thing that is different about this road.
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
            Devices you pair through the relay can do anything the desktop app
            can, including reading your sessions and their scrollback (which
            routinely contains API keys and source code) and removing
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

/** Resetting the address kills every relay link, so say so before doing it. */
export function ResetRelayDialog(props: {
  open: boolean;
  relayDevices: number;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { open, relayDevices, onCancel, onConfirm } = props;
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
            device paired through the relay
            {relayDevices > 0 ? ` (${relayDevices} now)` : ""} is disconnected,
            revoked, and will need to be paired again. Devices paired over
            Tailscale are not affected: the relay never admits them.
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
 * link is what this leads with, and it is offered whether or not a tunnel is
 * running: without one it points at loopback, which still works in a browser
 * on this machine and is the fastest way to see what the phone will see. The
 * QR code only appears for an address a phone can actually reach.
 *
 * A relay link always has an address; what it may lack is a running relay,
 * and an iPhone needs one more step for notifications (ADR-206 D7) — both
 * said here, where the link is being handed over.
 */
export function PairingResultDialog(props: {
  result: RemotePairResult | null;
  /** Loopback address of the listener, for the local link. */
  port: number | null;
  /** Whether the relay is connected, for a relay device's link. */
  relayRunning: boolean;
  onClose: () => void;
}) {
  const { result, port, relayRunning, onClose } = props;

  const tunnelUrl = result?.pairingUrl ?? null;
  const viaRelay = result?.device.via === "relay";
  // Same page the tunnel link would use — the server decides it once and
  // sends it back on the result, so a `full` device's loopback link opens the
  // web app rather than the phone client.
  const localUrl =
    result && port !== null
      ? `http://127.0.0.1:${port}${result.page}#${result.rawToken}`
      : null;

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
            {tunnelUrl && <PairingQr key={tunnelUrl} url={tunnelUrl} />}

            <div>
              <div className={styles.fieldLabel}>
                {tunnelUrl ? "Link" : "Link (this machine only)"}
              </div>
              <CopyField
                value={tunnelUrl ?? localUrl ?? ""}
                label="link"
                testId="remote-pairing-link"
              />
              {!tunnelUrl && (
                <div className={styles.fieldHint}>
                  No tunnel is running, so this address only works in a browser
                  here. Start a tunnel and pair again for a link your phone can
                  open.
                </div>
              )}
              {viaRelay && !relayRunning && (
                <div
                  className={styles.fieldHint}
                  data-testid="remote-pairing-relay-stopped"
                >
                  The relay isn&apos;t connected, so this link won&apos;t reach
                  this machine until it is. Start the relay from the card above.
                </div>
              )}
              {viaRelay && (
                <div
                  className={styles.fieldHint}
                  data-testid="remote-pairing-ios-hint"
                >
                  On an iPhone or iPad, notifications need the page on the Home
                  Screen: open the link in Safari, then Share → Add to Home
                  Screen, and open Manor from there.
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
