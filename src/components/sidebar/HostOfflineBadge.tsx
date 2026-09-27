import { useHostStore, selectHost } from "../../store/host-store";
import { describeHostOffline } from "../../lib/host-status";
import { LOCAL_HOST_ID } from "../../lib/hosts";
import { Tooltip } from "../ui/Tooltip/Tooltip";
import styles from "./ProjectItem.module.css";

type HostOfflineBadgeProps = {
  hostId: string | undefined;
};

/**
 * "Disconnected — reconnecting" on a remote project whose host is away
 * (ADR-178 §6). A plain badge, not a control: "Retry now" lives on the
 * banner over the project's panes and on the status-bar host indicator.
 * Nothing for a local project or a connected host.
 */
export function HostOfflineBadge(props: HostOfflineBadgeProps) {
  const { hostId } = props;

  const remoteHostId = hostId && hostId !== LOCAL_HOST_ID ? hostId : null;
  const host = useHostStore(selectHost(remoteHostId));
  const display = describeHostOffline(remoteHostId ? host : undefined);
  if (!display) return null;

  const target = host?.spec?.target ?? remoteHostId;
  const label = `${target}: ${display.banner}${display.detail ? `. ${display.detail}` : ""}`;

  return (
    <Tooltip label={label} side="right">
      <span
        className={styles.hostOfflineBadge}
        aria-label={label}
        data-testid="host-offline-badge"
      >
        {display.badge}
      </span>
    </Tooltip>
  );
}
