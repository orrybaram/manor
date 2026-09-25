import Server from "lucide-react/dist/esm/icons/server";
import { useAppStore } from "../../../store/app-store";
import { useProjectStore } from "../../../store/project-store";
import { useHostStore, selectHost } from "../../../store/host-store";
import { describeHostStatus } from "../../../lib/host-status";
import { LOCAL_HOST_ID } from "../../../lib/hosts";
import { Tooltip } from "../../ui/Tooltip/Tooltip";
import styles from "./StatusBar.module.css";

/**
 * Persistent per-project connection indicator (ADR-160 ticket 11 §2/§3).
 *
 * Mirrors `RemoteExposureIndicator`: nothing at all when the active
 * project's workspace lives on this machine, so it costs nothing in the
 * (still overwhelmingly common) local case. When it does render, clicking it
 * retries the connection — the same action the project settings host field
 * offers, just reachable without leaving the workspace.
 */
export function HostStatusIndicator() {
  const activeWorkspacePath = useAppStore((s) => s.activeWorkspacePath);
  const projects = useProjectStore((s) => s.projects);
  const project = projects.find((p) =>
    p.workspaces.some((w) => w.path === activeWorkspacePath),
  );
  const hostId = project?.hostId ?? LOCAL_HOST_ID;
  const host = useHostStore(selectHost(hostId));
  const retryConnect = useHostStore((s) => s.retryConnect);

  if (hostId === LOCAL_HOST_ID || !host) return null;

  const display = describeHostStatus(host);
  const target = host.spec?.target ?? hostId;
  const label = display.detail ? `${display.label} — ${display.detail}` : display.label;
  const toneClass =
    display.tone === "error"
      ? styles.hostBadgeError
      : display.tone === "warn"
        ? styles.hostBadgeWarn
        : display.tone === "pending"
          ? styles.hostBadgePending
          : "";

  return (
    <Tooltip label={`${target}: ${label}. Click to retry.`} side="top">
      <button
        className={`${styles.hostBadge} ${toneClass}`}
        onClick={() => void retryConnect(hostId)}
        aria-label={`Host ${target}: ${label}`}
      >
        <Server size={10} />
        <span>{display.label.toUpperCase()}</span>
      </button>
    </Tooltip>
  );
}
