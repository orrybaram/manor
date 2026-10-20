import { useCallback, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import type { DayBucket, StatCounter, StatsSummary } from "../../../electron.d";
import {
  formatUnblockLatency,
  humanCounterLabel,
} from "../../../store/stats-store";
import styles from "./StatsPopover.module.css";

/** Long enough that sweeping past the status bar does not open it. */
const HOVER_DELAY = 300;

/** The counters the quick view compares, today against the last week. */
const QUICK_COUNTERS: StatCounter[] = [
  "prompts",
  "toolCalls",
  "agentSessions",
  "prsMerged",
];

function formatCount(n: number | undefined): string {
  return (n ?? 0).toLocaleString();
}

type StatsPopoverProps = {
  summary: StatsSummary;
  /** The icon button: hovering or focusing it opens the popover. */
  children: React.ReactNode;
};

/**
 * Hover card behind the status bar's stats icon: today and the last seven
 * days side by side, so a glance answers "how much did I do" without
 * opening the full stats view (which the icon's click still does).
 */
export function StatsPopover(props: StatsPopoverProps) {
  const { summary, children } = props;
  const [open, setOpen] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearHoverTimeout = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const handleMouseEnter = useCallback(() => {
    clearHoverTimeout();
    timeoutRef.current = setTimeout(() => setOpen(true), HOVER_DELAY);
  }, [clearHoverTimeout]);

  const handleMouseLeave = useCallback(() => {
    clearHoverTimeout();
    timeoutRef.current = setTimeout(() => setOpen(false), 150);
  }, [clearHoverTimeout]);

  const handleFocus = useCallback(() => {
    clearHoverTimeout();
    setOpen(true);
  }, [clearHoverTimeout]);

  // Clicking through to the full view should not leave the card behind.
  const handleClick = useCallback(() => {
    clearHoverTimeout();
    setOpen(false);
  }, [clearHoverTimeout]);

  const { today, last7Days, streakWeeks } = summary;
  const latency = (bucket: DayBucket) => formatUnblockLatency(bucket) ?? "—";

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Anchor asChild>
        <span
          className={styles.anchor}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
          onFocus={handleFocus}
          onClick={handleClick}
        >
          {children}
        </span>
      </Popover.Anchor>
      <Popover.Portal>
        <Popover.Content
          className={styles.popover}
          side="top"
          align="end"
          sideOffset={8}
          collisionPadding={8}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
          // A hover card: focus stays where it was.
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          <table className={styles.table}>
            <thead>
              <tr>
                <th />
                <th className={styles.column}>Today</th>
                <th className={styles.column}>7 days</th>
              </tr>
            </thead>
            <tbody>
              {QUICK_COUNTERS.map((counter) => (
                <tr key={counter}>
                  <th className={styles.label}>{humanCounterLabel(counter)}</th>
                  <td className={styles.today}>{formatCount(today[counter])}</td>
                  <td className={styles.week}>
                    {formatCount(last7Days[counter])}
                  </td>
                </tr>
              ))}
              <tr>
                <th className={styles.label}>Avg. time to unblock</th>
                <td className={styles.today}>{latency(today)}</td>
                <td className={styles.week}>{latency(last7Days)}</td>
              </tr>
            </tbody>
          </table>
          <div className={styles.footer}>
            {streakWeeks > 0 && (
              <span className={styles.streak}>
                {streakWeeks}-week streak
              </span>
            )}
            <span className={styles.hint}>Click for all stats</span>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
