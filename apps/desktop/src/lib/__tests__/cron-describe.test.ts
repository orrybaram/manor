import { describe, expect, it } from "vitest";
import {
  cronFromPreset,
  cronProblem,
  describeCron,
  nextOccurrences,
  presetFromCron,
  timezoneLabel,
  timezoneOptions,
  type SchedulePreset,
} from "../cron-describe";

describe("describeCron", () => {
  it.each([
    ["0 9 * * 1-5", "Weekdays at 09:00"],
    ["15 * * * *", "Every hour at :15"],
    ["0 * * * *", "Every hour"],
    ["0 2 * * *", "Every day at 02:00"],
    ["0 16 * * 5", "Fridays at 16:00"],
    ["30 7 * * 0", "Sundays at 07:30"],
    ["30 7 * * 7", "Sundays at 07:30"],
    ["*/15 * * * *", "Every 15 minutes"],
    ["* * * * *", "Every minute"],
    ["0 9 1 * *", "Custom schedule"],
    ["0 9 * * 1,3", "Custom schedule"],
    ["nonsense", "Custom schedule"],
  ])("%s reads as %s", (cron, text) => {
    expect(describeCron(cron)).toBe(text);
  });
});

describe("presets", () => {
  it("round-trip through cron", () => {
    const presets: SchedulePreset[] = [
      { kind: "hourly", minute: 15 },
      { kind: "daily", hour: 2, minute: 0 },
      { kind: "weekdays", hour: 9, minute: 30 },
      { kind: "weekly", day: 5, hour: 16, minute: 0 },
    ];
    for (const preset of presets) expect(presetFromCron(cronFromPreset(preset))).toEqual(preset);
  });

  it("call anything else custom, keeping its cron", () => {
    expect(presetFromCron(" 0 9 1 * * ")).toEqual({ kind: "custom", cron: "0 9 1 * *" });
    expect(cronFromPreset({ kind: "custom", cron: "0 9 1 * *" })).toBe("0 9 1 * *");
    expect(presetFromCron("0 25 * * *").kind).toBe("custom");
  });
});

describe("timezoneLabel", () => {
  it("names a zone by its city, and UTC as UTC", () => {
    expect(timezoneLabel("Europe/London")).toBe("London");
    expect(timezoneLabel("America/New_York")).toBe("New York");
    expect(timezoneLabel("America/Argentina/Buenos_Aires")).toBe("Buenos Aires");
    expect(timezoneLabel("UTC")).toBe("UTC");
    expect(timezoneLabel("Etc/UTC")).toBe("UTC");
  });
});

describe("cronProblem and nextOccurrences", () => {
  it("refuse a pattern that isn't 5 fields or can't be read", () => {
    expect(cronProblem("0 9 * *", "UTC")).toMatch(/5 fields/);
    expect(cronProblem("0 99 * * *", "UTC")).not.toBeNull();
    expect(cronProblem("0 9 * * 1-5", "Europe/London")).toBeNull();
    expect(nextOccurrences("0 99 * * *", "UTC", 3)).toEqual([]);
  });

  it("list the next runs in the schedule's zone", () => {
    const from = new Date("2026-10-29T13:40:00Z"); // a Thursday
    const runs = nextOccurrences("0 9 * * 1-5", "UTC", 3, from).map((d) => d.toISOString());
    expect(runs).toEqual([
      "2026-10-30T09:00:00.000Z",
      "2026-11-02T09:00:00.000Z",
      "2026-11-03T09:00:00.000Z",
    ]);
  });
});

describe("timezoneOptions", () => {
  it("puts the schedule's zone and the viewer's first, once each", () => {
    const zones = timezoneOptions("Asia/Tokyo", "Europe/London");
    expect(zones.slice(0, 3)).toEqual(["Asia/Tokyo", "Europe/London", "UTC"]);
    expect(zones.filter((z) => z === "Europe/London")).toHaveLength(1);
    expect(zones).toContain("America/New_York");
  });
});
