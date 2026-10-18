import { useEffect, useState } from "react";
import Smartphone from "lucide-react/dist/esm/icons/smartphone";
import Trash2 from "lucide-react/dist/esm/icons/trash-2";

import { Button } from "../ui/Button/Button";
import { Tooltip } from "../ui/Tooltip/Tooltip";
import type { RemoteDeviceInfo } from "../../electron.d";
import { deviceHint } from "./deviceHint";
import styles from "./SettingsModal/SettingsModal.module.css";

/**
 * Current time that re-renders every 30 s and at `expiresAt` while a link is
 * waiting; an expired one has nothing left to count down.
 */
function useNow(expiresAt: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (expiresAt === null) return;
    // A new link (New link) counts down from now, not from the last tick.
    const refresh = setTimeout(() => setNow(Date.now()), 0);
    const left = expiresAt - Date.now();
    if (left <= 0) return () => clearTimeout(refresh);
    const expiry = setTimeout(() => setNow(Date.now()), left + 50);
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      clearTimeout(refresh);
      clearTimeout(expiry);
      clearInterval(tick);
    };
  }, [expiresAt]);
  return now;
}

/** One paired phone, with its revoke button. */
export function DeviceRow(props: {
  device: RemoteDeviceInfo;
  busy: boolean;
  onRevoke: () => void;
  onNewLink: () => void;
}) {
  const { device, busy, onRevoke, onNewLink } = props;
  const now = useNow(device.pending?.expiresAt ?? null);
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
        <div className={styles.fieldHint}>{deviceHint(device, now)}</div>
      </div>
      {device.pending && (
        <Button
          data-testid="remote-device-new-link"
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={onNewLink}
        >
          New link
        </Button>
      )}
      <Tooltip
        label={
          device.pending ? "Remove this device" : "Revoke this device's token"
        }
      >
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
