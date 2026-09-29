import { AnimatedCount } from "../../ui/AnimatedCount/AnimatedCount";
import { useMemo, type CSSProperties } from "react";
import {
  useAgentActivityStore,
  statusCountSeries,
  ACTIVITY_WINDOW_MS,
} from "../../../store/agent-activity-store";
import { useStatsStore } from "../../../store/stats-store";
import type { NeedsYouCard, OpenPrStats } from "../../../lib/home-dashboard-studio";
import { PR_STAGES } from "../../../lib/home-dashboard-studio";
import { formatAge } from "./format";
import { waitingOnLabel } from "./needs-you-labels";
import { Sparkline } from "./Sparkline";
import { PR_STAGE } from "./pr-stage";
import { StatTile } from "./StatTile";
import styles from "./StatTiles.module.css";

/** Sparkline resolution: one point per 15 minutes over the window. */
const SPARK_STEP_MS = 15 * 60 * 1000;

type StatTilesProps = {
  now: number;
  /** Visible (non-snoozed) Needs you cards — the Waiting on you count. */
  cards: readonly NeedsYouCard[];
  running: number;
  prStats: OpenPrStats;
};

/**
 * The four stat tiles (ADR-198 §1.3). The two sparklines count Agent statuses
 * over the activity window; Merged this week reads `dailyPrsMerged` from
 * the stats summary.
 */
export function StatTiles(props: StatTilesProps) {
  const { now, cards, running, prStats } = props;

  const snapshot = useAgentActivityStore((s) => s.snapshot);
  const summary = useStatsStore((s) => s.summary);

  const longest = cards.reduce<NeedsYouCard | null>(
    (best, card) =>
      card.ageMs != null && (best?.ageMs == null || card.ageMs > best.ageMs)
        ? card
        : best,
    null,
  );

  const { waitingSeries, workingSeries } = useMemo(() => {
    const agents = snapshot?.agents ?? {};
    const start = now - ACTIVITY_WINDOW_MS;
    return {
      waitingSeries: statusCountSeries(
        agents,
        start,
        now,
        SPARK_STEP_MS,
        (s) => s === "requires_input" || s === "error",
      ),
      workingSeries: statusCountSeries(
        agents,
        start,
        now,
        SPARK_STEP_MS,
        (s) => s === "working" || s === "thinking",
      ),
    };
  }, [snapshot, now]);

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
        <Sparkline values={waitingSeries} color="var(--red)" />
      </StatTile>
      <StatTile
        label="Agents working"
        color="var(--green)"
        value={<AnimatedCount value={running} />}
        foot="last 3 hours"
      >
        <Sparkline
          values={workingSeries}
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
                      "--c": PR_STAGE[stage].color,
                    } as CSSProperties
                  }
                />
              ))}
            </div>
            <div className={styles.legend}>
              {PR_STAGES.map((stage) => (
                <span
                  key={stage}
                  style={{ "--c": PR_STAGE[stage].color } as CSSProperties}
                >
                  <i />
                  {PR_STAGE[stage].short} {prStats.byStage[stage]}
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
