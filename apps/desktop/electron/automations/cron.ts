import { Cron } from "croner";

import type { AutomationSchedule } from "../../src/lib/automations";

/**
 * The one place an automation's cron is parsed. Every pattern is read as
 * 5-field cron in the schedule's IANA timezone (croner's "5-part" mode, so a
 * 6-field pattern with seconds is refused), and day-of-month and day-of-week
 * combine with OR, as in Vixie cron.
 */

/**
 * Past this many occurrences we stop counting: an hourly job after a year
 * asleep is reported as "10000 missed" without walking every hour.
 */
const MAX_COUNTED_OCCURRENCES = 10_000;

function parse(schedule: AutomationSchedule): Cron {
  return new Cron(schedule.cron, { timezone: schedule.timezone, mode: "5-part" });
}

/** Whether croner accepts `cron` as a 5-field pattern in `timezone`. */
export function isValidCron(cron: string, timezone: string): boolean {
  try {
    // A bad timezone only throws once a date is computed.
    parse({ cron, timezone }).nextRun();
    return true;
  } catch {
    return false;
  }
}

/** The next `count` occurrences strictly after `fromMs`; empty for a bad schedule. */
export function nextRuns(schedule: AutomationSchedule, fromMs: number, count: number): Date[] {
  try {
    return parse(schedule).nextRuns(count, new Date(fromMs));
  } catch {
    return [];
  }
}

/** The first occurrence strictly after `fromMs`, as ISO; null for a bad schedule. */
export function nextRunAfter(schedule: AutomationSchedule, fromMs: number): string | null {
  return nextRuns(schedule, fromMs, 1)[0]?.toISOString() ?? null;
}

export interface Occurrences {
  earliestMs: number;
  latestMs: number;
  /** How many fall in the range, capped at `MAX_COUNTED_OCCURRENCES`. */
  count: number;
}

/**
 * The occurrences in (`afterMs`, `nowMs`], or null when there are none.
 * Throws for a schedule croner refuses.
 */
export function occurrencesBetween(
  schedule: AutomationSchedule,
  afterMs: number,
  nowMs: number,
): Occurrences | null {
  const cron = parse(schedule);
  const first = cron.nextRun(new Date(afterMs));
  if (!first || first.getTime() > nowMs) return null;
  // `previousRuns` is exclusive and works in whole seconds; occurrences fall
  // on whole minutes, so the latest one before the next second is <= now.
  const ceiling = Math.floor(nowMs / 1000) * 1000 + 1000;
  const latest = cron.previousRuns(1, new Date(ceiling))[0] ?? first;
  let count = 1;
  let cursor: Date | null = first;
  while (count < MAX_COUNTED_OCCURRENCES) {
    cursor = cron.nextRun(cursor);
    if (!cursor || cursor.getTime() > nowMs) break;
    count++;
  }
  return { earliestMs: first.getTime(), latestMs: latest.getTime(), count };
}
