import { memo, useEffect, useState } from "react";
import { Button } from "../../ui/Button/Button";
import { Tooltip } from "../../ui/Tooltip/Tooltip";
import styles from "./BrowserPane.module.css";

interface RecordingIndicatorProps {
  /** Recording start time (ms epoch), from `paneRecordingStartedAt`. */
  startedAt: number;
  onStop: () => void;
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

/**
 * Live "Recording" badge for a pane an agent is capturing (ADR-158). An agent
 * can start a screen capture without the user asking for it, so this has to
 * be unmissable — and clicking it is the user's way to stop it without going
 * through the agent.
 *
 * Ticks its own elapsed-time display on a 1s interval, scoped to this
 * component rather than `LeafPane` — the pane's status bar re-renders on
 * every nav-state change (URL typing, loading, favicon, …), and dragging all
 * of that along for a once-a-second tick would be wasteful.
 */
export const RecordingIndicator = memo(function RecordingIndicator(
  props: RecordingIndicatorProps,
) {
  const { startedAt, onStop } = props;
  // `Date.now()` is impure, so it cannot be called during render (only from
  // an effect or event handler) — start at 0 and let the first tick, a
  // second later, correct it. The indicator mounts right as recording starts,
  // so that's a non-issue in practice.
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setElapsedMs(Date.now() - startedAt);
    }, 1000);
    return () => clearInterval(interval);
  }, [startedAt]);

  return (
    <Tooltip label="Stop recording">
      <Button
        variant="ghost"
        size="sm"
        className={styles.recordingIndicator}
        onClick={onStop}
      >
        <span className={styles.recordingDot} />
        Recording {formatElapsed(elapsedMs)}
      </Button>
    </Tooltip>
  );
});
