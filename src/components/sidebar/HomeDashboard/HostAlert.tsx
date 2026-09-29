import { useMemo } from "react";
import TriangleAlert from "lucide-react/dist/esm/icons/triangle-alert";
import { useHostStore, type HostStatusInfo } from "../../../store/host-store";
import type { ProjectInfo } from "../../../store/project-store";
import { describeHost } from "../../../lib/host-status";
import { Button } from "../../ui/Button/Button";
import styles from "./HostAlert.module.css";

/** More than two strips would push the dashboard below the fold. */
const MAX_ALERTS = 2;

type HostAlertProps = {
  projects: readonly ProjectInfo[];
  now: number;
};

/**
 * A strip per host a project uses that is away (ADR-198 §1.2): its
 * workspaces' agent and PR state may be stale until it reconnects.
 * `connecting` is left out: that's the app starting up or a Reconnect
 * already in flight, not a host that went away. No "went offline N ago":
 * `HostStatusInfo` doesn't carry when the host dropped.
 */
export function HostAlert(props: HostAlertProps) {
  const { projects, now } = props;

  const hosts = useHostStore((s) => s.hosts);
  const retryConnect = useHostStore((s) => s.retryConnect);

  const away = useMemo(() => {
    const workspaces = new Map<string, number>();
    for (const project of projects) {
      const visible = project.workspaces.filter((w) => !w.hidden).length;
      workspaces.set(project.hostId, (workspaces.get(project.hostId) ?? 0) + visible);
    }
    const out: { host: HostStatusInfo; workspaces: number }[] = [];
    for (const host of hosts) {
      const count = workspaces.get(host.hostId);
      if (count == null) continue;
      if (host.status === "connected" || host.status === "connecting") continue;
      out.push({ host, workspaces: count });
    }
    return out.slice(0, MAX_ALERTS);
  }, [projects, hosts]);

  if (away.length === 0) return null;

  return (
    <>
      {away.map(({ host, workspaces }) => {
        const display = describeHost(host, now);
        return (
          <div key={host.hostId} className={styles.alert} role="status">
            <TriangleAlert size={15} className={styles.icon} />
            <span>
              <b>{display?.target ?? host.hostId}</b> went offline. Status for {workspaces}{" "}
              workspace{workspaces === 1 ? "" : "s"} may be out of date.
            </span>
            {display?.canRetry !== false && (
              <Button
                variant="link"
                className={styles.reconnect}
                onClick={() => void retryConnect(host.hostId)}
              >
                Reconnect
              </Button>
            )}
          </div>
        );
      })}
    </>
  );
}
