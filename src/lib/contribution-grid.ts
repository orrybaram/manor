import type { DailyPrompts } from "../electron.d";

/**
 * Grid model for the stats page's contribution graph (ADR-168 §6).
 *
 * Kept apart from the component so the date arithmetic — which is all local
 * time, and easy to get wrong around week boundaries — can be tested directly.
 */

/** Intensity bucket. 0 is "recorded nothing"; 4 is the busiest band. */
export type ContributionLevel = 0 | 1 | 2 | 3 | 4;

export interface ContributionCell {
  /** Local YYYY-MM-DD. */
  day: string;
  count: number;
  level: ContributionLevel;
}

/** A column of the grid: seven cells, Sunday first. `null` is a future day. */
export type ContributionWeek = (ContributionCell | null)[];

/** Columns rendered when the caller does not ask for a narrower span. */
export const DEFAULT_WEEKS = 53;

function dayKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

/**
 * Intensity band for `count`, scaled against the busiest day in the range so a
 * quiet week still shows contrast instead of a single flat shade.
 */
export function levelFor(count: number, max: number): ContributionLevel {
  if (count <= 0) return 0;
  if (max <= 0) return 0;
  const ratio = count / max;
  if (ratio <= 0.25) return 1;
  if (ratio <= 0.5) return 2;
  if (ratio <= 0.75) return 3;
  return 4;
}

export interface ContributionGrid {
  weeks: ContributionWeek[];
  /** Busiest day in the rendered range; 0 when nothing was recorded. */
  max: number;
  /** Total prompts across the rendered range. */
  total: number;
  /** Days in the range that recorded at least one prompt. */
  activeDays: number;
}

/**
 * Builds `weeks` columns ending with the week that contains `today`. Columns
 * run Sunday→Saturday, matching GitHub, and days after `today` come back as
 * `null` so the final column renders partially filled rather than short.
 */
export function buildContributionGrid(
  daily: readonly DailyPrompts[],
  today: Date,
  weeks: number = DEFAULT_WEEKS,
): ContributionGrid {
  const counts = new Map<string, number>();
  for (const entry of daily) counts.set(entry.day, entry.count);

  // Saturday of the current week, so `today` lands in the last column.
  const endOfWeek = addDays(today, 6 - today.getDay());
  const start = addDays(endOfWeek, -(weeks * 7 - 1));
  const todayKey = dayKey(today);

  // Two passes: the first collects the range's counts so `max` is known before
  // any level is assigned.
  const days: { day: string; count: number; future: boolean }[] = [];
  for (let i = 0; i < weeks * 7; i++) {
    const day = dayKey(addDays(start, i));
    days.push({ day, count: counts.get(day) ?? 0, future: day > todayKey });
  }

  let max = 0;
  let total = 0;
  let activeDays = 0;
  for (const day of days) {
    if (day.future) continue;
    if (day.count > max) max = day.count;
    total += day.count;
    if (day.count > 0) activeDays++;
  }

  const grid: ContributionWeek[] = [];
  for (let week = 0; week < weeks; week++) {
    const column: ContributionWeek = [];
    for (let weekday = 0; weekday < 7; weekday++) {
      const day = days[week * 7 + weekday];
      column.push(
        day.future
          ? null
          : { day: day.day, count: day.count, level: levelFor(day.count, max) },
      );
    }
    grid.push(column);
  }

  return { weeks: grid, max, total, activeDays };
}

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

export interface MonthLabel {
  /** Index of the column the label sits above. */
  weekIndex: number;
  label: string;
}

/**
 * One label per month, placed on the first column whose Sunday falls in that
 * month. The leading column is skipped when its month would collide with the
 * next label a single column later.
 */
export function monthLabels(weeks: ContributionWeek[]): MonthLabel[] {
  const labels: MonthLabel[] = [];
  let lastMonth = -1;

  weeks.forEach((week, weekIndex) => {
    const first = week.find((cell) => cell !== null);
    if (!first) return;
    const month = Number(first.day.slice(5, 7)) - 1;
    if (month === lastMonth) return;
    lastMonth = month;
    labels.push({ weekIndex, label: MONTH_NAMES[month] });
  });

  return labels.length > 1 && labels[1].weekIndex - labels[0].weekIndex < 2
    ? labels.slice(1)
    : labels;
}
