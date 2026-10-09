import type { StatsSummary } from "../../../electron.d";
import {
  progressRatio,
  trackState,
  type BadgeSectionMeta,
} from "../../../lib/badges";
import { BadgeRow, ProgressBar } from "./BadgeRow";
import { isHiddenSecret, trackEntries } from "./trophy-data";
import styles from "./TrophyRoom.module.css";

type TrackPaneProps = {
  section: BadgeSectionMeta;
  summary: StatsSummary;
  revealed: ReadonlySet<string>;
  onReveal: (id: string) => void;
};

/**
 * One track: the track card (the title completing it earns and how close you
 * are), then its badges.
 */
export function TrackPane(props: TrackPaneProps) {
  const { section, summary, revealed, onReveal } = props;

  const state = trackState(section, summary);
  const entries = trackEntries(section, summary);

  return (
    <section className={styles.pane} aria-label={section.name}>
      <div className={styles.trackCard}>
        <div className={styles.trackCopy}>
          <span className={styles.eyebrow}>
            {`${section.name} · ${section.blurb}`}
          </span>
          <span className={styles.trackHeadline}>
            {state.complete
              ? "Complete · title "
              : "Complete it to earn the title "}
            <span className={styles.trackTitle}>{section.title}</span>
          </span>
        </div>

        <div className={styles.trackMeter}>
          <div className={styles.meterRow}>
            <span>Progress</span>
            <span>{`${state.earned} / ${state.total}`}</span>
          </div>
          <ProgressBar
            ratio={progressRatio({
              current: state.earned,
              target: state.total,
            })}
            label={`${section.name} progress`}
            tone="track"
          />
        </div>
      </div>

      <div className={styles.rows}>
        {entries.map((entry) => (
          <BadgeRow
            key={entry.badge.id}
            entry={entry}
            hidden={isHiddenSecret(entry, revealed)}
            onReveal={onReveal}
          />
        ))}
      </div>
    </section>
  );
}
