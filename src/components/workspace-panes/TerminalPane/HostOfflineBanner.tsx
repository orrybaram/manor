import { usePaneHostStore } from "../../../store/pane-host-store";
import { HostIndicator } from "../../hosts/HostIndicator";
import styles from "./HostOfflineBanner.module.css";

type HostOfflineBannerProps = {
  paneId: string;
};

/**
 * Slim banner over a terminal whose remote host is away (ADR-178 §6). The
 * terminal underneath keeps its last screen and ignores input until the host
 * is back (`isPaneInputBlocked`). Renders nothing for a local pane, so local
 * panes never subscribe to more than a missing map entry.
 */
export function HostOfflineBanner(props: HostOfflineBannerProps) {
  const { paneId } = props;
  const hostId = usePaneHostStore((s) => s.remoteHostByPane[paneId]);
  return <HostIndicator hostId={hostId} variant="banner" className={styles.overlay} />;
}
