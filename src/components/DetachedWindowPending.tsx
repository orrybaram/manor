import { useState } from "react";
import { useMountEffect } from "../hooks/useMountEffect";
import { useAppStore } from "../store/app-store";
import { returnToPrimaryWindow } from "../lib/detach";
import { ManorLogo } from "./ui/ManorLogo";
import { FallbackScreen } from "./ui/ErrorBoundary/FallbackScreen";
import { Button } from "./ui/Button/Button";

/** How long a detached window waits for its tab before saying it can't load. */
const DETACHED_TAB_TIMEOUT_MS = 10_000;

/**
 * A detached window whose claimed tab isn't in its layout (yet). Normally the
 * first broadcast is a frame away and this is a splash; if the layout read
 * failed, or the tab never arrives, it says so and offers to close
 * (ADR-232 D7) rather than showing a dimmed logo forever.
 */
export function DetachedWindowPending() {
  const layoutLoadError = useAppStore((s) => s.layoutLoadError);
  const [timedOut, setTimedOut] = useState(false);

  useMountEffect(() => {
    const timer = setTimeout(() => setTimedOut(true), DETACHED_TAB_TIMEOUT_MS);
    return () => clearTimeout(timer);
  });

  if (layoutLoadError !== null || timedOut) {
    return (
      <FallbackScreen
        fullWindow
        data-testid="detached-window-failed"
        title="Couldn't load this window"
        message={
          layoutLoadError ?? "Its tab didn't arrive. It is still in the main window."
        }
        actions={
          <Button variant="primary" onClick={returnToPrimaryWindow}>
            Close
          </Button>
        }
      />
    );
  }

  return (
    <div className="splash-screen" style={{ flex: 1 }}>
      <div className="drag-region" />
      <div className="splash-logo">
        <ManorLogo />
      </div>
    </div>
  );
}
