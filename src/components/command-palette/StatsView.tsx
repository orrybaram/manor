import { useMemo, type CSSProperties } from "react";
import type {
  DailyPrompts,
  DayBucket,
  StatCounter,
  StatGauge,
  StatsSummary,
} from "../../electron.d";
import {
  useStatsStore,
  counterDescription,
  formatUnblockLatency,
  humanCounterLabel,
} from "../../store/stats-store";
import { Tooltip } from "../ui/Tooltip/Tooltip";
import {
  BADGE_META,
  TIER_LABEL,
  progressRatio,
  type BadgeMeta,
} from "../../lib/badges";
import {
  buildContributionGrid,
  monthLabels,
  type ContributionCell,
} from "../../lib/contribution-grid";
import styles from "./CommandPalette.module.css";

/** Placeholder for a zero or never-recorded value. */
const EMPTY_CELL = "–";

type StatRow =
  | { kind: "counter"; counter: StatCounter }
  | { kind: "gauge"; gauge: StatGauge; label: string; description: string }
  | { kind: "latency"; label: string; description: string };

interface StatGroup {
  /** Rendered as a `// comment` divider above the group's rows. */
  label: string;
  rows: readonly StatRow[];
}

/**
 * Row order for the stats table (ADR-168 §6), grouped into readout sections.
 * `unblockMsTotal` is deliberately absent: it only exists as the numerator of
 * the derived "Unblock time" row.
 */
const STAT_GROUPS: readonly StatGroup[] = [
  {
    label: "agents",
    rows: [
      { kind: "counter", counter: "prompts" },
      { kind: "counter", counter: "toolCalls" },
      { kind: "counter", counter: "agentSessions" },
      { kind: "counter", counter: "subagents" },
      { kind: "counter", counter: "agentsResponded" },
      { kind: "counter", counter: "agentsKilled" },
      { kind: "counter", counter: "agentsKilledMidThought" },
    ],
  },
  {
    label: "flow",
    rows: [
      { kind: "counter", counter: "blocks" },
      { kind: "counter", counter: "unblocks" },
      {
        kind: "latency",
        label: "Unblock time",
        description: "Average time a waiting agent sat before you replied.",
      },
      { kind: "counter", counter: "fastUnblocks" },
      {
        kind: "gauge",
        gauge: "maxConcurrentAgents",
        label: "Max concurrent agents",
        description: "Most agents working or waiting on you at once.",
      },
    ],
  },
  {
    label: "worktrees",
    rows: [
      { kind: "counter", counter: "worktreesCreated" },
      { kind: "counter", counter: "worktreesRemoved" },
      { kind: "counter", counter: "worktreesMerged" },
    ],
  },
  {
    label: "pull requests",
    rows: [
      { kind: "counter", counter: "prApproved" },
      { kind: "counter", counter: "prChangesRequested" },
      { kind: "counter", counter: "prChecksFailed" },
    ],
  },
];

function rowLabel(row: StatRow): string {
  return row.kind === "counter" ? humanCounterLabel(row.counter) : row.label;
}

function rowDescription(row: StatRow): string {
  return row.kind === "counter"
    ? counterDescription(row.counter)
    : row.description;
}

function rowValue(row: StatRow, bucket: DayBucket): string {
  if (row.kind === "latency") {
    return formatUnblockLatency(bucket) ?? EMPTY_CELL;
  }
  const key = row.kind === "counter" ? row.counter : row.gauge;
  const value = bucket[key] ?? 0;
  return value === 0 ? EMPTY_CELL : value.toLocaleString();
}

/** Weekday rows that get a label, matching GitHub's Mon/Wed/Fri gutter. */
const WEEKDAY_LABELS: Record<number, string> = { 1: "Mon", 3: "Wed", 5: "Fri" };

function cellTitle(cell: ContributionCell): string {
  const [year, month, day] = cell.day.split("-").map(Number);
  const date = new Date(year, month - 1, day).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  const count = cell.count === 1 ? "1 prompt" : `${cell.count} prompts`;
  return `${count} on ${date}`;
}

interface ContributionGraphProps {
  daily: DailyPrompts[];
}

/**
 * A year of prompt activity, GitHub-style: Sunday-first columns, one column per
 * week, intensity scaled against the busiest day in view. Cells use the native
 * `title` rather than the `Tooltip` component — there are ~371 of them.
 */
function ContributionGraph(props: ContributionGraphProps) {
  const { daily } = props;
  const grid = useMemo(() => buildContributionGrid(daily, new Date()), [daily]);
  const labels = useMemo(() => monthLabels(grid.weeks), [grid.weeks]);

  const labelByWeek = new Map(labels.map((l) => [l.weekIndex, l.label]));

  return (
    <div className={styles.graph}>
      <div className={styles.graphHeader}>
        <span className={styles.graphTitle}>
          {`${grid.total.toLocaleString()} prompts in the last year`}
        </span>
        <span className={styles.graphMeta}>
          {`${grid.activeDays} active ${grid.activeDays === 1 ? "day" : "days"}`}
        </span>
      </div>

      <div className={styles.graphScroll}>
        <div className={styles.graphBody}>
          <div className={styles.graphWeekdays}>
            {Array.from({ length: 7 }, (_, weekday) => (
              <span key={weekday} className={styles.graphWeekday}>
                {WEEKDAY_LABELS[weekday] ?? ""}
              </span>
            ))}
          </div>

          <div className={styles.graphGrid}>
            <div className={styles.graphMonths}>
              {grid.weeks.map((_, weekIndex) => (
                <span key={weekIndex} className={styles.graphMonth}>
                  {labelByWeek.get(weekIndex) ?? ""}
                </span>
              ))}
            </div>

            <div className={styles.graphWeeks}>
              {grid.weeks.map((week, weekIndex) => (
                <div key={weekIndex} className={styles.graphWeek}>
                  {week.map((cell, weekday) =>
                    cell === null ? (
                      <span
                        key={weekday}
                        className={`${styles.graphCell} ${styles.graphCellFuture}`}
                      />
                    ) : (
                      <span
                        key={weekday}
                        className={styles.graphCell}
                        data-level={cell.level}
                        title={cellTitle(cell)}
                      />
                    ),
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className={styles.graphLegend}>
        <span>Less</span>
        {[0, 1, 2, 3, 4].map((level) => (
          <span key={level} className={styles.graphCell} data-level={level} />
        ))}
        <span>More</span>
      </div>
    </div>
  );
}

/* ── Achievements ── */

interface AchievementEntry {
  badge: BadgeMeta;
  /** ISO award timestamp, or `null` while the badge is still locked. */
  awardedAt: string | null;
  current: number;
  target: number;
  /** 0–1 completion; always 1 for an earned badge. */
  ratio: number;
}

/**
 * The rack, ordered the way an achievements screen orders one: earned first
 * (oldest unlock first, so the list reads as a history), then locked sorted by
 * how close they are — whatever you are about to unlock sits at the top of the
 * locked run.
 */
function buildEntries(summary: StatsSummary): AchievementEntry[] {
  const entries = BADGE_META.map((badge) => {
    const awardedAt = summary.badges[badge.id] ?? null;
    const progress = badge.progress(summary);
    return {
      badge,
      awardedAt,
      current: Math.min(progress.current, progress.target),
      target: progress.target,
      ratio: awardedAt ? 1 : progressRatio(progress),
    };
  });

  return entries.sort((a, b) => {
    if (a.awardedAt && b.awardedAt) {
      return a.awardedAt.localeCompare(b.awardedAt);
    }
    if (a.awardedAt) return -1;
    if (b.awardedAt) return 1;
    return b.ratio - a.ratio;
  });
}

function formatAwarded(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

interface AchievementCardProps {
  entry: AchievementEntry;
}

function AchievementCard(props: AchievementCardProps) {
  const { entry } = props;
  const { badge, awardedAt } = entry;
  const earned = awardedAt !== null;
  const pct = Math.round(entry.ratio * 100);

  return (
    <div
      className={`${styles.achievement} ${earned ? styles.achievementEarned : styles.achievementLocked}`}
      style={{ "--badge-color": badge.color } as CSSProperties}
    >
      <div className={styles.achievementMedal} aria-hidden="true">
        {earned ? badge.icon : "🔒"}
      </div>

      <div className={styles.achievementBody}>
        <div className={styles.achievementHead}>
          <span className={styles.achievementTitle}>{badge.title}</span>
          <span className={styles.achievementTier} data-tier={badge.tier}>
            {TIER_LABEL[badge.tier]}
          </span>
        </div>

        {earned ? (
          <div className={styles.achievementDesc}>{badge.description}</div>
        ) : (
          <div
            className={`${styles.achievementDesc} ${styles.achievementDescHidden}`}
          >
            Hidden until unlocked
          </div>
        )}

        {earned ? (
          <div className={styles.achievementEarnedAt}>
            {`Unlocked ${formatAwarded(awardedAt)}`}
          </div>
        ) : (
          <div className={styles.achievementProgress}>
            <div
              className={styles.achievementBar}
              role="progressbar"
              aria-valuenow={pct}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={`${badge.title} progress`}
            >
              <span
                className={styles.achievementBarFill}
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className={styles.achievementCount}>
              {`${entry.current.toLocaleString()} / ${entry.target.toLocaleString()}`}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

interface AchievementsProps {
  summary: StatsSummary;
}

/**
 * Achievements as a games console shows them: a completion readout, the run
 * you are closest to finishing pinned above the rack, then the rack itself.
 * A locked badge keeps its description hidden — you see the title, the tier
 * and how far along you are, but what it actually asks for is the surprise.
 */
function Achievements(props: AchievementsProps) {
  const { summary } = props;
  const entries = useMemo(() => buildEntries(summary), [summary]);

  const earnedCount = entries.filter((e) => e.awardedAt !== null).length;
  const total = entries.length;
  const completion = total === 0 ? 0 : Math.round((earnedCount / total) * 100);
  const nextUp = entries.find((e) => e.awardedAt === null && e.ratio > 0);

  return (
    <section className={styles.achievements}>
      <div className={styles.achievementsHeader}>
        <span className={styles.statsGroupHeading}>// achievements</span>
        <span className={styles.achievementsScore}>
          {`${earnedCount} / ${total} · ${completion}%`}
        </span>
      </div>

      <div className={styles.achievementsBar}>
        <span
          className={styles.achievementsBarFill}
          style={{ width: `${completion}%` }}
        />
      </div>

      {nextUp && (
        <div className={styles.achievementsNext}>
          <span className={styles.achievementsNextLabel}>Next up</span>
          <span className={styles.achievementsNextTitle}>
            {nextUp.badge.title}
          </span>
          <span className={styles.achievementsNextCount}>
            {`${nextUp.current.toLocaleString()} / ${nextUp.target.toLocaleString()}`}
          </span>
        </div>
      )}

      <div className={styles.achievementsGrid}>
        {entries.map((entry) => (
          <AchievementCard key={entry.badge.id} entry={entry} />
        ))}
      </div>
    </section>
  );
}

interface HeroTileProps {
  label: string;
  value: string;
  /** Small secondary readout under the number, e.g. the 7-day total. */
  sub: string;
  /** Set on the "terminated" tile so its number reads in the danger colour. */
  ominous?: boolean;
}

function HeroTile(props: HeroTileProps) {
  const { label, value, sub, ominous } = props;
  return (
    <div className={styles.statsTile}>
      <div className={styles.statsTileLabel}>{label}</div>
      <div
        className={`${styles.statsTileValue} ${ominous ? styles.statsTileValueOminous : ""}`}
      >
        {value}
      </div>
      <div className={styles.statsTileSub}>{sub}</div>
    </div>
  );
}

/** Usage stats and milestone badges (ADR-168 §6). */
export function StatsView() {
  const summary = useStatsStore((s) => s.summary);

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

  const { today, last7Days, allTime } = summary;

  const columns: { key: string; label: string; bucket: DayBucket }[] = [
    { key: "today", label: "Today", bucket: today },
    { key: "last7Days", label: "7 Days", bucket: last7Days },
    { key: "allTime", label: "All Time", bucket: allTime },
  ];

  const count = (bucket: DayBucket, key: StatCounter | StatGauge): number =>
    bucket[key] ?? 0;

  return (
    <div className={styles.statsView}>
      <div className={styles.statsStreak}>
        {summary.streakDays > 0
          ? `🔥 ${summary.streakDays}-day streak`
          : "No streak yet"}
      </div>

      <div className={styles.statsTiles}>
        <HeroTile
          label="Prompts today"
          value={count(today, "prompts").toLocaleString()}
          sub={`7d ${count(last7Days, "prompts").toLocaleString()}`}
        />
        <HeroTile
          label="Terminated"
          value={count(today, "agentsKilled").toLocaleString()}
          sub={`all time ${count(allTime, "agentsKilled").toLocaleString()}`}
          ominous
        />
        <HeroTile
          label="Peak swarm"
          value={count(today, "maxConcurrentAgents").toLocaleString()}
          sub={`best ${count(allTime, "maxConcurrentAgents").toLocaleString()}`}
        />
        <HeroTile
          label="Unblock time"
          value={formatUnblockLatency(today) ?? EMPTY_CELL}
          sub={`7d ${formatUnblockLatency(last7Days) ?? EMPTY_CELL}`}
        />
      </div>

      <ContributionGraph daily={summary.dailyPrompts} />

      <table className={styles.statsTable}>
        <thead>
          <tr>
            <th className={styles.statsRowLabel} scope="col">
              <span className="sr-only">Stat</span>
            </th>
            {columns.map((col) => (
              <th key={col.key} className={styles.statsCell} scope="col">
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        {STAT_GROUPS.map((group) => (
          <tbody key={group.label}>
            <tr>
              <th
                className={styles.statsGroupLabel}
                scope="colgroup"
                colSpan={columns.length + 1}
              >
                {`// ${group.label}`}
              </th>
            </tr>
            {group.rows.map((row) => (
              <tr key={rowLabel(row)} className={styles.statsRow}>
                <th className={styles.statsRowLabel} scope="row">
                  <span className={styles.statsRowLabelText}>
                    <Tooltip label={rowDescription(row)} side="top">
                      <span className={styles.statsRowLabelName}>
                        {rowLabel(row)}
                      </span>
                    </Tooltip>
                  </span>
                </th>
                {columns.map((col) => {
                  const value = rowValue(row, col.bucket);
                  return (
                    <td
                      key={col.key}
                      className={`${styles.statsCell} ${value === EMPTY_CELL ? styles.statsCellEmpty : ""}`}
                    >
                      {value}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        ))}
      </table>

      <Achievements summary={summary} />
    </div>
  );
}
