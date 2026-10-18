import { useEffect, useState } from "react";
import Smartphone from "lucide-react/dist/esm/icons/smartphone";
import Trash2 from "lucide-react/dist/esm/icons/trash-2";

import { Button } from "../ui/Button/Button";
import { Tooltip } from "../ui/Tooltip/Tooltip";
import type { RemoteDeviceInfo } from "../../electron.d";
import { deviceHint } from "./deviceHint";
import styles from "./SettingsModal/SettingsModal.module.css";

/** Current time that re-renders each minute and at `expiresAt` while pending. */
function useNow(expiresAt: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (expiresAt === null) return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const left = expiresAt - Date.now();
    if (left > 0) timers.push(setTimeout(() => setNow(Date.now()), left + 50));
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      timers.forEach(clearTimeout);
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
