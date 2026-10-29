/**
 * An automation's cron as people read it, and the presets the Automations
 * page offers. Pure: every function here reads its arguments and nothing
 * else, except `nextOccurrences`, which asks croner.
 *
 * Only the shapes the presets write are named ("Weekdays at 09:00"); any
 * other pattern is a "Custom schedule", shown with its cron beside it.
 */

import { Cron } from "croner";

export type SchedulePreset =
  | { kind: "hourly"; minute: number }
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekdays"; hour: number; minute: number }
  /** `day` is cron's day of week, 0 (Sunday) to 6. */
  | { kind: "weekly"; day: number; hour: number; minute: number }
  | { kind: "custom"; cron: string };

export type SchedulePresetKind = SchedulePreset["kind"];

export const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

const INT = /^\d{1,2}$/;

function field(value: string, max: number): number | null {
  if (!INT.test(value)) return null;
  const n = Number(value);
  return n <= max ? n : null;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** "09:00". */
export function clockTime(hour: number, minute: number): string {
  return `${pad(hour)}:${pad(minute)}`;
}

/** The preset a cron was written by, or `custom`. */
export function presetFromCron(cron: string): SchedulePreset {
  const parts = cron.trim().split(/\s+/);
  const custom: SchedulePreset = { kind: "custom", cron: cron.trim() };
  if (parts.length !== 5) return custom;
  const [m, h, dom, mon, dow] = parts;
  const minute = field(m, 59);
  if (minute === null || dom !== "*" || mon !== "*") return custom;
  if (h === "*" && dow === "*") return { kind: "hourly", minute };
  const hour = field(h, 23);
  if (hour === null) return custom;
  if (dow === "*") return { kind: "daily", hour, minute };
  if (dow === "1-5") return { kind: "weekdays", hour, minute };
  const day = field(dow, 7);
  if (day !== null) return { kind: "weekly", day: day % 7, hour, minute };
  return custom;
}

export function cronFromPreset(preset: SchedulePreset): string {
  switch (preset.kind) {
    case "hourly":
      return `${preset.minute} * * * *`;
    case "daily":
      return `${preset.minute} ${preset.hour} * * *`;
    case "weekdays":
      return `${preset.minute} ${preset.hour} * * 1-5`;
    case "weekly":
      return `${preset.minute} ${preset.hour} * * ${preset.day}`;
    case "custom":
      return preset.cron;
  }
}

/** What `describeCron` calls a pattern it has no words for. */
export const CUSTOM_SCHEDULE = "Custom schedule";

/** "Weekdays at 09:00", "Every hour at :15", "Every 15 minutes", "Custom schedule". */
export function describeCron(cron: string): string {
  const preset = presetFromCron(cron);
  switch (preset.kind) {
    case "hourly":
      return preset.minute === 0 ? "Every hour" : `Every hour at :${pad(preset.minute)}`;
    case "daily":
      return `Every day at ${clockTime(preset.hour, preset.minute)}`;
    case "weekdays":
      return `Weekdays at ${clockTime(preset.hour, preset.minute)}`;
    case "weekly":
      return `${WEEKDAY_NAMES[preset.day]}s at ${clockTime(preset.hour, preset.minute)}`;
    case "custom": {
      const every = /^\*\/(\d{1,2}) \* \* \* \*$/.exec(preset.cron.replace(/\s+/g, " "));
      if (every) {
        const n = Number(every[1]);
        if (n === 1) return "Every minute";
        if (n > 1 && n < 60) return `Every ${n} minutes`;
      }
      if (preset.cron === "* * * * *") return "Every minute";
      return CUSTOM_SCHEDULE;
    }
  }
}

/** "London" for `Europe/London`, "New York" for `America/New_York`, "UTC". */
export function timezoneLabel(timezone: string): string {
  if (timezone === "UTC" || timezone === "Etc/UTC" || timezone === "Etc/GMT" || timezone === "GMT") {
    return "UTC";
  }
  const city = timezone.split("/").pop() ?? timezone;
  return city.replace(/_/g, " ");
}

/** The viewer's own zone, for a new automation. */
export function localTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * The zones a schedule can be in, for its picker: the schedule's own and the
 * viewer's first, then every zone this runtime knows, A to Z.
 */
export function timezoneOptions(current: string, local: string = localTimezone()): string[] {
  let all: string[];
  try {
    const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
    all = intl.supportedValuesOf?.("timeZone") ?? [];
  } catch {
    all = [];
  }
  const first = [current, local, "UTC"].filter((z, i, list) => z && list.indexOf(z) === i);
  return [...first, ...all.filter((z) => !first.includes(z))];
}

/**
 * Why a cron can't be used, or null. Main checks again on save; this is the
 * page's early word, so a half-typed pattern is never sent.
 */
export function cronProblem(cron: string, timezone: string): string | null {
  if (cron.trim().split(/\s+/).length !== 5) {
    return "Use 5 fields: minute hour day-of-month month day-of-week";
  }
  try {
    new Cron(cron.trim(), { timezone, mode: "5-part" }).nextRun();
    return null;
  } catch {
    return "That isn't a cron pattern Manor can read";
  }
}

/** The next `count` occurrences after `from`; empty for a pattern croner refuses. */
export function nextOccurrences(
  cron: string,
  timezone: string,
  count: number,
  from: Date = new Date(),
): Date[] {
  try {
    return new Cron(cron.trim(), { timezone, mode: "5-part" }).nextRuns(count, from);
  } catch {
    return [];
  }
}
