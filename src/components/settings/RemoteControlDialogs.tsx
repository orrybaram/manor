import { useEffect, useState } from "react";
import QRCode from "qrcode";
import * as Dialog from "@radix-ui/react-dialog";
import Copy from "lucide-react/dist/esm/icons/copy";
import Check from "lucide-react/dist/esm/icons/check";

import { useMountEffect } from "../../hooks/useMountEffect";
import { Button } from "../ui/Button/Button";
import { EmojiInput } from "../ui/EmojiAutocomplete";
import type { RemotePairResult } from "../../electron.d";
import styles from "./SettingsModal/SettingsModal.module.css";
import dialogStyles from "../sidebar/dialogs.module.css";

/**
 * Turning remote control on starts the relay — an outward-facing action, so
 * the dialog names what becomes reachable rather than asking "are you sure".
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
            Turn on remote control?
          </Dialog.Title>
          <Dialog.Description className={dialogStyles.confirmDescription}>
            Paired devices get full control through the Manor relay: your
            sessions and their scrollback (often API keys and source code),
            terminals and workspaces. Traffic is end-to-end encrypted, so the
            relay can&apos;t read it. Turns off when Manor quits.
          </Dialog.Description>
          <div className={dialogStyles.confirmActions}>
            <Button variant="secondary" onClick={onCancel}>
              Cancel
            </Button>
            <Button variant="primary" onClick={onConfirm}>
              Turn on
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * Naming a device is where consent to its full control happens, so that is
 * said here, plainly, rather than as a standing warning on the page. With remote control off,
 * pairing turns it on — said on the button, since that is what makes this
 * machine reachable.
 */
export function AddDeviceDialog(props: {
  open: boolean;
  /** Whether remote control is already on. */
  enabled: boolean;
  busy: boolean;
  /** Why the last pairing failed, shown where the user is looking. */
  error: string | null;
  onCancel: () => void;
  onPair: (label: string) => void;
}) {
  const { open, enabled, busy, error, onCancel, onPair } = props;
  const [label, setLabel] = useState("");
  const trimmed = label.trim();
  const submit = () => {
    if (trimmed && !busy) onPair(trimmed);
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={dialogStyles.confirmOverlay} />
        <Dialog.Content
          data-testid="remote-add-device-dialog"
          className={dialogStyles.confirmDialog}
          onCloseAutoFocus={() => setLabel("")}
        >
          <Dialog.Title className={dialogStyles.confirmTitle}>
            Add a device
          </Dialog.Title>
          <Dialog.Description className={dialogStyles.confirmDescription}>
            The device gets full control of Manor, including your terminals
            and workspaces.
            {!enabled && " Pairing turns on remote control."}
          </Dialog.Description>
          <div className={styles.remotePairingBody}>
            <EmojiInput
              data-testid="remote-pair-label"
              placeholder="Device name, e.g. “my phone”"
              value={label}
              maxLength={64}
              autoFocus
              onChange={(e) => setLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
            />
            {error && <div className={styles.linearError}>{error}</div>}
          </div>
          <div className={dialogStyles.confirmActions}>
            <Button variant="secondary" onClick={onCancel}>
              Cancel
            </Button>
            <Button
              data-testid="remote-pair-submit"
              variant="primary"
              disabled={busy || trimmed.length === 0}
              onClick={submit}
            >
              {enabled ? "Pair" : "Pair and turn on"}
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
export function PairingQr(props: {
  url: string;
  /** Rendered width and height in px. */
  size?: number;
  alt?: string;
}) {
  const { url, size = 220, alt = "Pairing QR code" } = props;

  const [data, setData] = useState<string | null>(null);
  useMountEffect(() => {
    let live = true;
    // Drawn at 2× so it stays sharp on a Retina display.
    void QRCode.toDataURL(url, { margin: 1, width: size * 2 })
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
  return (
    <img
      className={styles.remoteQr}
      style={{ width: size, height: size }}
      src={data}
      alt={alt}
    />
  );
}

/**
 * A link that exists to be opened on another device, offered as a small
 * "Copy link" rather than shown: the QR code beside it is the main way in.
 * The link rides on `data-link` for tests, which have no clipboard.
 */
export function CopyLinkButton(props: { url: string; testId?: string }) {
  const { url, testId } = props;
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <Button
      data-testid={testId}
      data-link={url}
      variant="ghost"
      size="sm"
      onClick={() => {
        void navigator.clipboard.writeText(url).then(() => setCopied(true));
      }}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
      {copied ? "Copied" : "Copy link"}
    </Button>
  );
}

/**
 * The one moment the pairing link exists in the UI.
 *
 * The device needs only the link — the token rides in its fragment — so the
 * QR code is the whole dialog, with a small Copy link for pasting it
 * elsewhere. The device is registered but has not connected yet, so the
 * title asks for the scan rather than calling it paired.
 *
 * What the link may lack is a relay that is up, and an iPhone needs one more
 * step for notifications (ADR-206 D7): both said in small print here, where
 * the link is being handed over.
 */
export function PairingResultDialog(props: {
  result: RemotePairResult | null;
  /** Whether the relay is up or connecting, so the link will reach this machine. */
  relayUp: boolean;
  onClose: () => void;
}) {
  const { result, relayUp, onClose } = props;

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
            Scan with {result?.device.label}
          </Dialog.Title>
          <Dialog.Description className={dialogStyles.confirmDescription}>
            This code is shown once. If you lose it, remove the device and add
            it again.
          </Dialog.Description>

          {pairingUrl && (
            <div className={styles.remotePairingQrBody}>
              <PairingQr key={pairingUrl} url={pairingUrl} />
              <CopyLinkButton url={pairingUrl} testId="remote-pairing-link" />
              {!relayUp && (
                <div
                  className={styles.fieldHint}
                  data-testid="remote-pairing-relay-stopped"
                >
                  The relay isn&apos;t connected yet, so the link won&apos;t
                  work until it is.
                </div>
              )}
              <div className={styles.fieldHint}>
                iPhone: add Manor to the Home Screen to get notifications.
              </div>
            </div>
          )}

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
