import Globe from "lucide-react/dist/esm/icons/globe";

import { useRemoteControlStore } from "../../../store/remote-control-store";
import { Button } from "../../ui/Button/Button";
import { Tooltip } from "../../ui/Tooltip/Tooltip";
import { describeExposure } from "./remote-exposure";
import styles from "./StatusBar.module.css";

const TONE_CLASS = {
  ok: "",
  warning: styles.remoteBadgeWarning,
  failed: styles.remoteBadgeFailed,
};

/**
 * Persistent "you are reachable from outside" indicator (ADR-161 ticket 6 §5,
 * ADR-206 D6).
 *
 * Lives in the status bar rather than in settings because the hazard is a user
 * who left a road open and forgot. It renders nothing at all when neither the
 * tunnel nor the relay is up, so it costs nothing in the normal case — and it
 * deliberately shows failures too, since a road that died still needs
 * explaining.
 *
 * One badge for both roads. The tooltip lists each one that is not off, with
 * its own connection count, and a click stops **every** road at once. That is
 * the safer of the two choices: the badge exists for the moment someone wants
 * this machine unreachable *now*, and a click that closed one road and left
 * the other open is exactly the surprise it is there to prevent. (The
 * settings page stops them one at a time.)
 */
export function RemoteExposureIndicator() {
  const status = useRemoteControlStore((s) => s.status);
  const stopTunnel = useRemoteControlStore((s) => s.stopTunnel);
  const stopRelay = useRemoteControlStore((s) => s.stopRelay);

  const view = describeExposure(status);
  if (!view) return null;

  const stopAll = () => {
    if (view.stop.tunnel) void stopTunnel();
    if (view.stop.relay) void stopRelay();
  };

  return (
    <Tooltip label={view.label} side="top">
      <Button
        variant="link"
        data-testid="remote-exposure-badge"
        className={`${styles.remoteBadge} ${TONE_CLASS[view.tone]}`}
        onClick={stopAll}
        aria-label={
          view.exposed ? "Stop remote access" : "Dismiss remote failure"
        }
      >
        <Globe size={10} />
        <span>{view.text}</span>
      </Button>
    </Tooltip>
  );
}
