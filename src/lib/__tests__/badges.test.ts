import { describe, it, expect } from "vitest";
import { BADGE_META, progressRatio, TIER_LABEL } from "../badges";
import type { StatsSummary } from "../../electron.d";

/**
 * Literal copy of the ids in `electron/stats-badges.ts`, in order. The renderer
 * cannot import from `electron/`, so this hardcoded list is the seam that fails
 * loudly when the two catalogues drift.
 */
const ELECTRON_BADGE_IDS = [
  "first-blood",
  "executioner",
  "massacre",
  "delegator",
  "swarm",
  "quick-draw",
  "gardener",
  "reaper",
  "shipper",
  "centurion",
  "week-streak",
  "month-streak",
];

/**
 * Literal copy of every threshold in `electron/stats-badges.ts`, keyed by id.
 * The renderer draws "18 / 25" bars from its own mirror, so a threshold that
 * drifts from main would show progress against a target that never unlocks.
 */
const ELECTRON_BADGE_TARGETS: Record<string, number> = {
  "first-blood": 1,
  executioner: 25,
  massacre: 100,
  delegator: 10,
  swarm: 5,
  "quick-draw": 25,
  gardener: 50,
  reaper: 50,
  shipper: 10,
  centurion: 100,
  "week-streak": 7,
  "month-streak": 30,
};

function summary(overrides: Partial<StatsSummary> = {}): StatsSummary {
  return {
    today: {},
    last7Days: {},
    allTime: {},
    streakDays: 0,
    dailyPrompts: [],
    badges: {},
    enabled: true,
    ...overrides,
  };
}

describe("BADGE_META", () => {
  it("has twelve badges", () => {
    expect(BADGE_META).toHaveLength(12);
  });

  it("has unique ids", () => {
    const ids = BADGE_META.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("matches the electron catalogue ids and order", () => {
    expect(BADGE_META.map((b) => b.id)).toEqual(ELECTRON_BADGE_IDS);
  });

  it("gives every badge a title and description", () => {
    for (const badge of BADGE_META) {
      expect(badge.title.length).toBeGreaterThan(0);
      expect(badge.description.length).toBeGreaterThan(0);
    }
  });

  it("gives every badge an icon and an `r g b` colour triple", () => {
    for (const badge of BADGE_META) {
      expect(badge.icon.length).toBeGreaterThan(0);
      expect(badge.color).toMatch(/^\d{1,3} \d{1,3} \d{1,3}$/);
    }
  });

  it("gives every badge a known tier", () => {
    for (const badge of BADGE_META) {
      expect(TIER_LABEL[badge.tier]).toBeTruthy();
    }
  });

  it("matches the electron catalogue thresholds", () => {
    for (const badge of BADGE_META) {
      expect(badge.progress(summary()).target).toBe(
        ELECTRON_BADGE_TARGETS[badge.id],
      );
    }
  });

  it("reads progress out of the summary", () => {
    const s = summary({
      allTime: { agentsKilled: 40 },
      today: { subagents: 3 },
      streakDays: 4,
    });

    const byId = new Map(BADGE_META.map((b) => [b.id, b]));
    expect(byId.get("executioner")!.progress(s)).toEqual({
      current: 40,
      target: 25,
    });
    expect(byId.get("massacre")!.progress(s)).toEqual({
      current: 40,
      target: 100,
    });
    expect(byId.get("delegator")!.progress(s)).toEqual({
      current: 3,
      target: 10,
    });
    expect(byId.get("week-streak")!.progress(s)).toEqual({
      current: 4,
      target: 7,
    });
  });

  it("starts every badge at zero progress on a blank summary", () => {
    for (const badge of BADGE_META) {
      expect(badge.progress(summary()).current).toBe(0);
    }
  });
});

describe("progressRatio", () => {
  it("clamps at 1 once the threshold is passed", () => {
    expect(progressRatio({ current: 40, target: 25 })).toBe(1);
  });

  it("floors at 0", () => {
    expect(progressRatio({ current: -3, target: 25 })).toBe(0);
  });

  it("scales in between", () => {
    expect(progressRatio({ current: 5, target: 10 })).toBe(0.5);
  });
});
