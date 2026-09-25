import { useState } from "react";
import WifiOff from "lucide-react/dist/esm/icons/wifi-off";
import { useHostStore, selectHost, type HostStatusInfo } from "../../../store/host-store";
import { usePaneHostStore } from "../../../store/pane-host-store";
import { describeHostOffline, secondsUntilRetry } from "../../../lib/host-status";
import { useMountEffect } from "../../../hooks/useMountEffect";
import { Button } from "../../ui/Button/Button";
import { Tooltip } from "../../ui/Tooltip/Tooltip";
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
  const host = useHostStore(selectHost(hostId));
  const display = describeHostOffline(hostId ? host : undefined);
  if (!hostId || !host || !display) return null;

  return <OfflineBanner hostId={hostId} host={host} display={display} />;
}

type OfflineBannerProps = {
  hostId: string;
  host: HostStatusInfo;
  display: NonNullable<ReturnType<typeof describeHostOffline>>;
};

function OfflineBanner(props: OfflineBannerProps) {
  const { hostId, host, display } = props;

  const retryConnect = useHostStore((s) => s.retryConnect);
  const [now, setNow] = useState(() => Date.now());
  useMountEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  });
  const seconds = secondsUntilRetry(host, now);

  const text = (
    <span className={styles.text}>
      {display.banner}
      {seconds !== null && seconds > 0 ? ` · retrying in ${seconds}s` : ""}
    </span>
  );

  return (
    <div className={styles.banner} role="status" data-testid="host-offline-banner">
      <WifiOff size={12} className={styles.icon} />
      {display.detail ? <Tooltip label={display.detail}>{text}</Tooltip> : text}
      {display.canRetry && (
        <Button
          size="sm"
          variant="ghost"
          className={styles.retry}
          onClick={() => void retryConnect(hostId)}
        >
          Retry now
        </Button>
      )}
    </div>
  );
}
