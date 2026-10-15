import { useStatsStore } from "../../store/stats-store";
import { TrophyRoom } from "./trophy-room/TrophyRoom";
import { FallbackScreen } from "../ui/ErrorBoundary/FallbackScreen";
import { Button } from "../ui/Button/Button";
import styles from "./CommandPalette.module.css";

/** Usage stats and badges: the trophy room (ADR-168 §6, ADR-212). */
export function StatsView() {
  const summary = useStatsStore((s) => s.summary);
  const focusSection = useStatsStore((s) => s.focusSection);
  const focusSeq = useStatsStore((s) => s.focusSeq);
  const loadError = useStatsStore((s) => s.loadError);
  const retry = useStatsStore((s) => s.retry);

  if (!summary && loadError !== null) {
    return (
      <FallbackScreen
        data-testid="stats-load-failed"
        title="Couldn't load your stats"
        message={loadError}
        actions={
          <Button size="sm" variant="primary" onClick={() => void retry()}>
            Retry
          </Button>
        }
      />
    );
  }

  if (!summary) {
    return <div className={styles.empty}>Loading…</div>;
  }

  if (!summary.enabled) {
    return (
      <div className={styles.empty}>
        Stats collection is off. Enable it in Settings → General.
      </div>
    );
  }

  // Keyed on the focus request so asking for a track while the room is
  // already open remounts it there.
  return (
    <TrophyRoom key={focusSeq} summary={summary} initialTrack={focusSection} />
  );
}
