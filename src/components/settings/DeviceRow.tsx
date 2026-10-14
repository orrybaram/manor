import Smartphone from "lucide-react/dist/esm/icons/smartphone";
import Trash2 from "lucide-react/dist/esm/icons/trash-2";

import { Button } from "../ui/Button/Button";
import { Tooltip } from "../ui/Tooltip/Tooltip";
import { relativeShort } from "../../utils/relative-time";
import type { RemoteDeviceInfo } from "../../electron.d";
import styles from "./SettingsModal/SettingsModal.module.css";

/** One paired phone, with its revoke button. */
export function DeviceRow(props: {
  device: RemoteDeviceInfo;
  busy: boolean;
  onRevoke: () => void;
  /**
   * Who paired it, when not the user here: "This Mac" for a pairing the
   * desktop minted on a host for one of its own phones (ADR-228 D9).
   */
  via?: string;
}) {
  const { device, busy, onRevoke, via } = props;
  return (
    <div data-testid="remote-device-row" className={styles.remoteDeviceRow}>
      <Smartphone size={14} className={styles.remoteDeviceIcon} />
      <div className={styles.remoteDeviceBody}>
        <div className={styles.remoteDeviceLabel}>
          <span>{device.label}</span>
          {device.hasPush && (
            <span className={styles.remoteSendBadge}>push</span>
          )}
          {via && (
            <span className={styles.remoteSendBadge} data-testid="remote-device-via">
              via {via}
            </span>
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
