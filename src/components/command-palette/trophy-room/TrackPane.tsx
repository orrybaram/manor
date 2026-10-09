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
 * One track: the seal card (what sealing it earns and how close you are),
 * the seal ladder, then the gild set behind its divider.
 */
export function TrackPane(props: TrackPaneProps) {
  const { section, summary, revealed, onReveal } = props;

  const state = trackState(section, summary);
  const { base, gild } = trackEntries(section, summary);
  const { sealProgress, gildProgress } = state;
  const gildCount = `${gildProgress.current} / ${gildProgress.target}`;

  return (
    <section className={styles.pane} aria-label={section.name}>
      <div className={styles.sealCard}>
        <div className={styles.sealCopy}>
          <span className={styles.eyebrow}>
            {`${section.name} · ${section.blurb}`}
          </span>
          <span className={styles.sealHeadline}>
            {state.sealed ? "Sealed · " : "Seal it to earn the title "}
            <span
              className={styles.sealTitle}
              data-gilded={state.gilded || undefined}
            >
              {section.title}
            </span>
          </span>
        </div>

        <div className={styles.sealMeter}>
          <div className={styles.meterRow}>
            <span>Seal</span>
            <span>{`${sealProgress.current} / ${sealProgress.target}`}</span>
          </div>
          <ProgressBar
            ratio={progressRatio(sealProgress)}
            label={`${section.name} seal progress`}
            tone="seal"
          />
          {gildProgress.target > 0 && (
            <div className={styles.meterRow}>
              <span>Gild</span>
              <span data-gilded={state.gilded || undefined}>
                {state.gilded
                  ? `gilded · ${gildCount}`
                  : state.sealed
                    ? gildCount
                    : `after seal · ${gildCount}`}
              </span>
            </div>
          )}
        </div>
      </div>

      <div className={styles.rows}>
        {base.map((entry) => (
          <BadgeRow
            key={entry.badge.id}
            entry={entry}
            hidden={isHiddenSecret(entry, revealed)}
            onReveal={onReveal}
          />
        ))}

        {gild.length > 0 && (
          <>
            <div className={styles.gildDivider}>
              Gilding · unlocks after the seal
            </div>
            {gild.map((entry) => (
              <BadgeRow
                key={entry.badge.id}
                entry={entry}
                hidden={isHiddenSecret(entry, revealed)}
                padlocked={!state.sealed}
                onReveal={onReveal}
              />
            ))}
          </>
        )}
      </div>
    </section>
  );
}
