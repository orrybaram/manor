import type { StatsSummary } from "../../../electron.d";
import { BADGE_SECTIONS, type BadgeSection } from "../../../lib/badges";
import { Button } from "../../ui/Button/Button";
import { BadgeRow, Medal, ProgressBar } from "./BadgeRow";
import { nextUp, recentUnlocks } from "./trophy-data";
import styles from "./TrophyRoom.module.css";

type SummaryPaneProps = {
  summary: StatsSummary;
  onSelectTrack: (section: BadgeSection) => void;
};

/**
 * The Badges tab's landing pane: the closest badge in each unsealed track,
 * then what you unlocked most recently. A Next up card opens its track.
 */
export function SummaryPane(props: SummaryPaneProps) {
  const { summary, onSelectTrack } = props;

  const next = nextUp(summary);
  const recent = recentUnlocks(summary);

  return (
    <section className={styles.pane} aria-label="Summary">
      <h3 className={styles.heading}>Next up</h3>
      {next.length === 0 ? (
        <p className={styles.emptyNote}>Every track is sealed.</p>
      ) : (
        <div className={styles.nextGrid}>
          {next.map((entry) => {
            const track = BADGE_SECTIONS.find(
              (s) => s.id === entry.badge.section,
            );
            return (
              <Button
                key={entry.badge.id}
                variant="ghost"
                className={styles.nextCard}
                onClick={() => onSelectTrack(entry.badge.section)}
              >
                <span className={styles.nextHead}>
                  <Medal badge={entry.badge} state="locked" />
                  <span className={styles.nextText}>
                    <span className={styles.rowName}>{entry.badge.title}</span>
                    <span className={styles.eyebrow}>{track?.name}</span>
                  </span>
                </span>
                <span className={styles.rowDesc}>
                  {entry.badge.description}
                </span>
                <span className={styles.rowProgress}>
                  <ProgressBar
                    ratio={entry.ratio}
                    label={`${entry.badge.title} progress`}
                    tier={entry.badge.tier}
                  />
                  <span className={styles.count}>
                    {`${entry.current.toLocaleString()} / ${entry.target.toLocaleString()}`}
                  </span>
                </span>
              </Button>
            );
          })}
        </div>
      )}

      <h3 className={styles.heading}>Recent unlocks</h3>
      {recent.length === 0 ? (
        <p className={styles.emptyNote}>Nothing unlocked yet.</p>
      ) : (
        <div className={styles.rows}>
          {recent.map((entry) => (
            <BadgeRow key={entry.badge.id} entry={entry} />
          ))}
        </div>
      )}
    </section>
  );
}
