import type { CSSProperties } from "react";
import type { OpenPrStats } from "../../../lib/home-dashboard-studio";
import type { NewWorkspaceHandler } from "../../../lib/start-issue-work";
import { PR_STAGES } from "../../../lib/pr-readiness";
import { useStatsStore } from "../../../store/stats-store";
import { AnimatedCount } from "../../ui/AnimatedCount/AnimatedCount";
import { formatAge } from "./format";
import { PR_STAGE } from "./pr-stage";
import { RailAgents } from "./RailAgents";
import { RailUpNext } from "./RailUpNext";
import styles from "./DashboardRail.module.css";

type DashboardRailProps = {
  now: number;
  prStats: OpenPrStats;
  onNewWorkspace?: NewWorkspaceHandler;
  /** Placement in the page grid, from HomeDashboard. */
  className?: string;
};

/**
 * Home's secondary rail: the numbers worth a glance — Agents working, Open
 * PRs, Merged this week, Up next. Muted on purpose: it sits beside the Needs
 * you list and PR table on a wide pane and under them on a narrow one.
 */
export function DashboardRail(props: DashboardRailProps) {
  const { now, prStats, onNewWorkspace, className } = props;

  return (
    <aside className={[styles.rail, className].filter(Boolean).join(" ")} aria-label="Activity and stats">
      <RailAgents now={now} />
      <OpenPrs stats={prStats} />
      <MergedThisWeek />
      <RailUpNext onNewWorkspace={onNewWorkspace} />
    </aside>
  );
}

/** Open PRs: the total, the oldest's age, and how they split across stages. */
function OpenPrs(props: { stats: OpenPrStats }) {
  const { stats } = props;

  return (
    <section className={styles.section} aria-label="Open PRs">
      <h2 className={styles.label}>Open PRs</h2>
      <div className={styles.big}>
        <AnimatedCount value={stats.total} className={styles.bigNum} />
        {stats.oldestAgeMs != null && (
          <span className={styles.meta}>oldest {formatAge(stats.oldestAgeMs)}</span>
        )}
      </div>
      {stats.total > 0 && (
        <>
          <div className={styles.stages}>
            {/* Every stage stays mounted (an empty one at zero width) so a change eases instead of jumping. */}
            {PR_STAGES.map((stage) => (
              <span
                key={stage}
                style={{ flexGrow: stats.byStage[stage], "--c": PR_STAGE[stage].color } as CSSProperties}
              />
            ))}
          </div>
          <div className={styles.legend}>
            {PR_STAGES.map((stage) => (
              <span key={stage} style={{ "--c": PR_STAGE[stage].color } as CSSProperties}>
                <i />
                {stats.byStage[stage]} {PR_STAGE[stage].short}
              </span>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

/** "2026-11-25" as that local day's short weekday ("Wed"). */
function weekday(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "short" });
}

/** Merged this week: the 7-day total and a bar per day from the stats summary. */
function MergedThisWeek() {
  const summary = useStatsStore((s) => s.summary);

  // `summary` is null until main answers; claim nothing meanwhile.
  const days = summary?.dailyPrsMerged ?? [];
  const total = days.reduce((sum, d) => sum + d.count, 0);
  const max = Math.max(1, ...days.map((d) => d.count));

  return (
    <section className={styles.section} aria-label="Merged this week">
      <h2 className={styles.label}>Merged this week</h2>
      {summary == null ? null : !summary.enabled ? (
        <p className={styles.note}>Usage stats are off</p>
      ) : (
        <>
          <div className={styles.big}>
            <AnimatedCount value={total} className={styles.bigNum} />
          </div>
          {days.length > 1 && (
            <>
              <div
                className={styles.bars}
                role="img"
                aria-label={`Merged per day: ${days.map((d) => `${weekday(d.day)} ${d.count}`).join(", ")}`}
              >
                {days.map((d, i) => (
                  <i
                    key={d.day}
                    className={i === days.length - 1 ? styles.today : undefined}
                    style={{ height: `${Math.max(4, (d.count / max) * 100)}%` }}
                    data-empty={d.count === 0 || undefined}
                    title={`${weekday(d.day)} · ${d.count} merged`}
                  />
                ))}
              </div>
              <div className={styles.axis} aria-hidden="true">
                <span>{weekday(days[0].day)}</span>
                <span>today</span>
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}
