import Globe from "lucide-react/dist/esm/icons/globe";

import { useRemoteControlStore } from "../../../store/remote-control-store";
import { requestUi } from "../../../utils/ui-request";
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
 * who left the relay running and forgot. It renders nothing at all when the
 * relay is off, so it costs nothing in the normal case — and it deliberately
 * shows failures too, since a relay that died still needs explaining.
 *
 * Styled like the host chip beside it. A click opens Settings → Remote
 * control, where turning it off is one switch away.
 */
export function RemoteExposureIndicator() {
  const status = useRemoteControlStore((s) => s.status);

  const view = describeExposure(status);
  if (!view) return null;

  return (
    <Tooltip label={view.label} side="top">
      <Button
        variant="link"
        data-testid="remote-exposure-badge"
        className={`${styles.remoteBadge} ${TONE_CLASS[view.tone]}`}
        onClick={() => requestUi({ type: "open-remote-settings" })}
        aria-label="Open remote control settings"
      >
        <Globe size={10} />
        <span>{view.text}</span>
      </Button>
    </Tooltip>
  );
}
