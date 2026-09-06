import { useState } from "react";
import type { DayBucket, StatCounter, StatGauge } from "../../electron.d";
import {
  useStatsStore,
  formatUnblockLatency,
  humanCounterLabel,
} from "../../store/stats-store";
import { BADGE_META } from "../../lib/badges";
import { Tooltip } from "../ui/Tooltip/Tooltip";
import { Button } from "../ui/Button/Button";
import { ResetStatsDialog } from "./ResetStatsDialog";
import styles from "./CommandPalette.module.css";

/** Placeholder for a zero or never-recorded value. */
const EMPTY_CELL = "–";

type StatRow =
  | { kind: "counter"; counter: StatCounter }
  | { kind: "gauge"; gauge: StatGauge; label: string }
  | { kind: "latency"; label: string };

/**
 * Row order for the stats table (ADR-168 §6). `unblockMsTotal` is deliberately
 * absent: it only exists as the numerator of the derived "Unblock time" row.
 */
const STAT_ROWS: readonly StatRow[] = [
  { kind: "counter", counter: "prompts" },
  { kind: "counter", counter: "toolCalls" },
  { kind: "counter", counter: "agentSessions" },
  { kind: "counter", counter: "subagents" },
  { kind: "counter", counter: "agentsResponded" },
  { kind: "counter", counter: "agentsKilled" },
  { kind: "counter", counter: "blocks" },
  { kind: "counter", counter: "unblocks" },
  { kind: "latency", label: "Unblock time" },
  { kind: "counter", counter: "fastUnblocks" },
  { kind: "gauge", gauge: "maxConcurrentAgents", label: "Max concurrent agents" },
  { kind: "counter", counter: "worktreesCreated" },
  { kind: "counter", counter: "worktreesRemoved" },
  { kind: "counter", counter: "worktreesMerged" },
  { kind: "counter", counter: "prApproved" },
  { kind: "counter", counter: "prChangesRequested" },
  { kind: "counter", counter: "prChecksFailed" },
];

function rowLabel(row: StatRow): string {
  return row.kind === "counter" ? humanCounterLabel(row.counter) : row.label;
}

function rowValue(row: StatRow, bucket: DayBucket): string {
  if (row.kind === "latency") {
    return formatUnblockLatency(bucket) ?? EMPTY_CELL;
  }
  const key = row.kind === "counter" ? row.counter : row.gauge;
  const value = bucket[key] ?? 0;
  return value === 0 ? EMPTY_CELL : String(value);
}

/**
 * Palette footer for the stats view: a destructive "Reset Stats" action behind
 * a confirm dialog, mirroring `KillAllFooter` in `ProcessesView`.
 */
export function ResetStatsFooter() {
  const [confirmOpen, setConfirmOpen] = useState(false);

  return (
    <>
      <div className={styles.detailFooter}>
        <Button
          variant="link"
          className={`${styles.footerHint} ${styles.footerHintDanger}`}
          onClick={() => setConfirmOpen(true)}
        >
          Reset Stats
        </Button>
      </div>

      <ResetStatsDialog open={confirmOpen} onOpenChange={setConfirmOpen} />
    </>
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

  const columns: { key: string; label: string; bucket: DayBucket }[] = [
    { key: "today", label: "Today", bucket: summary.today },
    { key: "last7Days", label: "7 Days", bucket: summary.last7Days },
    { key: "allTime", label: "All Time", bucket: summary.allTime },
  ];

  return (
    <div className={styles.statsView}>
      <div className={styles.statsStreak}>
        {summary.streakDays > 0
          ? `🔥 ${summary.streakDays}-day streak`
          : "No streak yet"}
      </div>

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
        <tbody>
          {STAT_ROWS.map((row) => (
            <tr key={rowLabel(row)}>
              <th className={styles.statsRowLabel} scope="row">
                {rowLabel(row)}
              </th>
              {columns.map((col) => (
                <td key={col.key} className={styles.statsCell}>
                  {rowValue(row, col.bucket)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>

      <div className={styles.statsBadges}>
        {BADGE_META.map((badge) => {
          const awardedAt = summary.badges[badge.id];
          const label = awardedAt
            ? `${badge.description} — earned ${new Date(awardedAt).toLocaleDateString()}`
            : badge.description;
          return (
            <Tooltip key={badge.id} label={label} side="top">
              <span
                className={`${styles.statsBadge} ${awardedAt ? "" : styles.statsBadgeLocked}`}
              >
                {badge.title}
              </span>
            </Tooltip>
          );
        })}
      </div>
    </div>
  );
}
