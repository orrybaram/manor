import { AnimatedCount } from "../../ui/AnimatedCount/AnimatedCount";
import type { CSSProperties } from "react";
import {
  useAgentActivityStore,
  ACTIVITY_WINDOW_MS,
} from "../../../store/agent-activity-store";
import { useStatsStore } from "../../../store/stats-store";
import type {
  NeedsYouCard,
  OpenPrStats,
  PrStage,
} from "../../../lib/home-dashboard-studio";
import { PR_STAGES } from "../../../lib/home-dashboard-studio";
import { formatAge, formatClock } from "./format";
import { waitingOnLabel } from "./needs-you-labels";
import { Sparkline } from "./Sparkline";
import { StatTile } from "./StatTile";
import styles from "./StatTiles.module.css";

/** Stage bar colours: running checks yellow, waiting on reviewers dim, blocked red, ready green. */
const STAGE_COLOR: Record<PrStage, string> = {
  checks: "var(--yellow)",
  review: "var(--hd-fg-4)",
  blocked: "var(--red)",
  ready: "var(--green)",
};

const STAGE_LABEL: Record<PrStage, string> = {
  checks: "Checks",
  review: "Review",
  blocked: "Blocked",
  ready: "Ready",
};

type StatTilesProps = {
  now: number;
  /** Visible (non-snoozed) Needs you cards — the Waiting on you count. */
  cards: readonly NeedsYouCard[];
  running: number;
  prStats: OpenPrStats;
};

/**
 * The four stat tiles (ADR-198 §1.3). The two sparklines read the activity
 * recorder's 5-minute samples; Merged this week reads `dailyPrsMerged` from
 * the stats summary.
 */
export function StatTiles(props: StatTilesProps) {
  const { now, cards, running, prStats } = props;

  const samples = useAgentActivityStore((s) => s.samples);
  const startedAt = useAgentActivityStore((s) => s.startedAt);
  const summary = useStatsStore((s) => s.summary);

  const longest = cards.reduce<NeedsYouCard | null>(
    (best, card) =>
      card.ageMs != null && (best?.ageMs == null || card.ageMs > best.ageMs)
        ? card
        : best,
    null,
  );

  // History is in memory only (ADR-198 §3): until the recorder has a full
  // window, say where the chart starts.
  const since =
    now - startedAt < ACTIVITY_WINDOW_MS
      ? `since ${formatClock(startedAt)}`
      : "last 3 hours";

  // `summary` is null until main answers; don't claim stats are off meanwhile.
  const statsOn = summary?.enabled === true;
  const mergedFoot =
    summary == null
      ? undefined
      : statsOn
        ? "Last 7 days"
        : "Usage stats are off";
  const merged = summary?.dailyPrsMerged ?? [];
  const mergedTotal = merged.reduce((sum, d) => sum + d.count, 0);

  return (
    <div className={styles.tiles}>
      <StatTile
        label="Waiting on you"
        color="var(--red)"
        value={<AnimatedCount value={cards.length} />}
        foot={
          longest?.ageMs != null && (
            <>
              Longest: <b>{formatAge(longest.ageMs)}</b> ·{" "}
              {waitingOnLabel(longest)}
            </>
          )
        }
      >
        <Sparkline values={samples.map((s) => s.waiting)} color="var(--red)" />
      </StatTile>
      <StatTile
        label="Agents working"
        color="var(--green)"
        value={<AnimatedCount value={running} />}
        foot={since}
      >
        <Sparkline
          values={samples.map((s) => s.working)}
          color="var(--green)"
        />
      </StatTile>
      <StatTile
        label="Open PRs"
        color="var(--accent)"
        value={<AnimatedCount value={prStats.total} />}
        aside={
          prStats.oldestAgeMs != null
            ? `oldest ${formatAge(prStats.oldestAgeMs)}`
            : undefined
        }
      >
        {prStats.total > 0 && (
          <>
            <div className={styles.stages}>
              {/* Every stage stays mounted (an empty one at zero width) so a change eases instead of jumping. */}
              {PR_STAGES.map((stage) => (
                <span
                  key={stage}
                  style={
                    {
                      flexGrow: prStats.byStage[stage],
                      "--c": STAGE_COLOR[stage],
                    } as CSSProperties
                  }
                />
              ))}
            </div>
            <div className={styles.legend}>
              {PR_STAGES.map((stage) => (
                <span
                  key={stage}
                  style={{ "--c": STAGE_COLOR[stage] } as CSSProperties}
                >
                  <i />
                  {STAGE_LABEL[stage]} {prStats.byStage[stage]}
                </span>
              ))}
            </div>
          </>
        )}
      </StatTile>
      <StatTile
        label="Merged this week"
        color="var(--magenta)"
        value={statsOn ? <AnimatedCount value={mergedTotal} /> : "—"}
        foot={mergedFoot}
      >
        {statsOn && (
          <Sparkline
            values={merged.map((d) => d.count)}
            color="var(--magenta)"
            bars
          />
        )}
      </StatTile>
    </div>
  );
}
