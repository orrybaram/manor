import { useState } from "react";
import X from "lucide-react/dist/esm/icons/x";
import { Button } from "../ui/Button/Button";
import { useMountEffect } from "../../hooks/useMountEffect";
import {
  currentPushState,
  enablePush,
  resubscribePush,
  type PushState,
} from "../../lib/web-push";
import styles from "./Phone.module.css";

const DISMISSED_KEY = "manor.web.notifyStripDismissed";

function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * ADR-206 D7: the web app's way to turn on push. Shown only to a paired
 * device (never the desktop renderer), asks for permission from the tap, and
 * disappears once notifications are on.
 *
 * It sits above the terminal on a screen with no height to spare, so it can
 * be dismissed for good, and it says nothing at all when there is nothing to
 * do here (permission denied is the browser's setting, not this page's).
 */
export function EnableNotifications() {
  const [state, setState] = useState<PushState>(currentPushState);
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(readDismissed);

  useMountEffect(() => {
    // Already permitted in an earlier visit: re-send the subscription quietly
    // so a host that lost it (or a new relay pairing) is kept current. Never
    // asks — there is no gesture here — so it does nothing otherwise.
    if (currentPushState() !== "on") return;
    let mounted = true;
    void resubscribePush().then(
      (next) => {
        if (mounted) setState(next);
      },
      () => {
        if (mounted) setState("hidden");
      },
    );
    return () => {
      mounted = false;
    };
  });

  if (state === "hidden" || state === "on" || state === "denied") return null;
  if (dismissed) return null;

  const dismiss = (
    <Button
      variant="ghost"
      className={styles.notifyDismiss}
      aria-label="Dismiss"
      data-testid="enable-notifications-dismiss"
      onClick={() => {
        setDismissed(true);
        try {
          localStorage.setItem(DISMISSED_KEY, "1");
        } catch {
          // Private mode: dismissed for this visit only.
        }
      }}
    >
      <X size={16} />
    </Button>
  );

  if (state === "needs-install") {
    return (
      <div className={styles.notifyStrip} data-testid="enable-notifications">
        <span className={styles.notifyText}>
          Add to Home Screen to get notifications
        </span>
        {dismiss}
      </div>
    );
  }
  return (
    <div className={styles.notifyStrip} data-testid="enable-notifications">
      <Button
        size="sm"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          // Synchronously, inside the tap: `enablePush` asks for permission
          // before its first await, while the user activation still counts.
          enablePush()
            .then(setState, () => setState("hidden"))
            .finally(() => setBusy(false));
        }}
      >
        Enable notifications
      </Button>
      {dismiss}
    </div>
  );
}
