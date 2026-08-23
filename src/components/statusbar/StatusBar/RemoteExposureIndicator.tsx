import Globe from "lucide-react/dist/esm/icons/globe";

import {
  useRemoteControlStore,
  selectExposed,
} from "../../../store/remote-control-store";
import { Tooltip } from "../../ui/Tooltip/Tooltip";
import styles from "./StatusBar.module.css";

/**
 * Persistent "you are reachable from outside" indicator (ADR-161 ticket 6 §5).
 *
 * Lives in the status bar rather than in settings because the hazard is a user
 * who left a tunnel running and forgot. It renders nothing at all when no
 * tunnel is up, so it costs nothing in the normal case — and it deliberately
 * shows `failed` too, since a tunnel that died still needs explaining.
 */
export function RemoteExposureIndicator() {
  const exposed = useRemoteControlStore(selectExposed);
  const tunnel = useRemoteControlStore((s) => s.status.tunnel);
  const listeners = useRemoteControlStore((s) => s.status.listeners);
  const stopTunnel = useRemoteControlStore((s) => s.stopTunnel);

  if (!exposed && tunnel.state !== "failed") return null;

  const starting = tunnel.state === "starting";
  const failed = tunnel.state === "failed";

  const label = failed
    ? (tunnel.error ?? "The tunnel stopped unexpectedly.")
    : starting
      ? "Starting a tunnel. This machine is not reachable yet."
      : `Reachable at ${tunnel.url}. ${
          listeners === 0
            ? "No device is connected right now."
            : `${listeners} device${listeners === 1 ? "" : "s"} connected.`
        } Click to stop.`;

  return (
    <Tooltip label={label} side="top">
      <button
        className={`${styles.remoteBadge} ${failed ? styles.remoteBadgeFailed : ""}`}
        onClick={() => void stopTunnel()}
        aria-label={failed ? "Tunnel failed" : "Stop remote tunnel"}
      >
        <Globe size={10} />
        <span>
          {failed ? "TUNNEL FAILED" : starting ? "STARTING" : "REMOTE"}
        </span>
      </button>
    </Tooltip>
  );
}
