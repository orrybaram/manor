import { useState } from "react";
import { Button } from "../ui/Button/Button";
import { useMountEffect } from "../../hooks/useMountEffect";
import {
  currentPushState,
  enablePush,
  resubscribePush,
  type PushState,
} from "../../lib/web-push";
import styles from "./Phone.module.css";

/**
 * ADR-206 D7: the web app's way to turn on push. Shown only to a paired
 * device (never the desktop renderer), asks for permission from the tap, and
 * disappears once notifications are on.
 */
export function EnableNotifications() {
  const [state, setState] = useState<PushState>(currentPushState);
  const [busy, setBusy] = useState(false);

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

  if (state === "hidden" || state === "on") return null;

  if (state === "needs-install") {
    return (
      <div className={styles.notifyStrip} data-testid="enable-notifications">
        Add to Home Screen to get notifications
      </div>
    );
  }
  if (state === "denied") {
    return (
      <div className={styles.notifyStrip} data-testid="enable-notifications">
        Notifications are blocked in this browser&apos;s settings
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
    </div>
  );
}
