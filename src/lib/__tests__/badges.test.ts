import { describe, it, expect } from "vitest";
import {
  BADGE_META,
  BADGE_SECTIONS,
  earnedTitles,
  progressRatio,
  STARTER_TITLES,
  TIER_LABEL,
  tierTally,
  trackState,
} from "../badges";
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
  "cold-blooded",
  "extinction",
  "chatterbox",
  "novelist",
  "marathon",
  "regular",
  "devoted",
  "half-year",
  "year-round",
  "busy-hands",
  "industrious",
  "overclocked",
  "hive-mind",
  "summoner",
  "recruiter",
  "legion",
  "good-listener",
  "gatekeeper",
  "lightning",
  "forester",
  "scorched-earth",
  "fleet",
  "armada",
  "hot-streak",
  "seal-of-approval",
  "red-ink",
  "works-on-my-machine",
  "platinum",
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
  "week-streak": 4,
  "month-streak": 12,
  "cold-blooded": 25,
  extinction: 500,
  chatterbox: 1000,
  novelist: 10_000,
  marathon: 250,
  regular: 100,
  devoted: 300,
  "half-year": 26,
  "year-round": 52,
  "busy-hands": 10_000,
  industrious: 100_000,
  overclocked: 1000,
  "hive-mind": 10,
  summoner: 500,
  recruiter: 1000,
  legion: 100,
  "good-listener": 1000,
  gatekeeper: 500,
  lightning: 250,
  forester: 250,
  "scorched-earth": 250,
  fleet: 50,
  armada: 200,
  "hot-streak": 5,
  "seal-of-approval": 10,
  "red-ink": 10,
  "works-on-my-machine": 25,
  platinum: 39,
};

function summary(overrides: Partial<StatsSummary> = {}): StatsSummary {
  return {
    today: {},
    last7Days: {},
    allTime: {},
    streakWeeks: 0,
    dailyPrompts: [],
    dailyPrsMerged: [],
    badges: {},
    enabled: true,
    ...overrides,
  };
}

describe("BADGE_META", () => {
  it("has forty badges", () => {
    expect(BADGE_META).toHaveLength(40);
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

  it("puts every badge in a known section, and leaves no section empty", () => {
    const sections = new Set(BADGE_SECTIONS.map((s) => s.id));
    for (const badge of BADGE_META) {
      expect(sections.has(badge.section)).toBe(true);
    }
    for (const section of BADGE_SECTIONS) {
      expect(BADGE_META.some((b) => b.section === section.id)).toBe(true);
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
      streakWeeks: 2,
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
      current: 2,
      target: 4,
    });
  });

  it("gives every section a reward title", () => {
    for (const section of BADGE_SECTIONS) {
      expect(section.title.length).toBeGreaterThan(0);
    }
  });

  it("flags a few secret badges", () => {
    const n = BADGE_META.filter((b) => b.secret).length;
    expect(n).toBeGreaterThanOrEqual(2);
    expect(n).toBeLessThanOrEqual(4);
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

const AT = (n: number) => `2026-01-${String(n).padStart(2, "0")}T00:00:00.000Z`;

/** Awards every badge in a section, one day apart starting at `start`. */
function award(
  sectionId: string,
  { start = 1 }: { start?: number } = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  BADGE_META.filter((b) => b.section === sectionId).forEach((b, i) => {
    out[b.id] = AT(start + i);
  });
  return out;
}

const staff = BADGE_SECTIONS.find((s) => s.id === "staff")!;
const tenure = BADGE_SECTIONS.find((s) => s.id === "tenure")!;
const manor = BADGE_SECTIONS.find((s) => s.id === "manor")!;

describe("BADGE_SECTIONS", () => {
  it("runs the four tracks, then Lord of the Manor", () => {
    expect(BADGE_SECTIONS.map((s) => s.id)).toEqual([
      "staff",
      "orders",
      "grounds",
      "tenure",
      "manor",
    ]);
  });

  it("puts only the platinum badge in the manor track", () => {
    expect(
      BADGE_META.filter((b) => b.section === "manor").map((b) => b.id),
    ).toEqual(["platinum"]);
  });
});

describe("trackState", () => {
  it("starts empty and incomplete", () => {
    expect(trackState(tenure, summary())).toEqual({
      earned: 0,
      total: 6,
      complete: false,
    });
  });

  it("is incomplete while any badge is missing", () => {
    const badges = award("tenure");
    delete badges["year-round"];
    const state = trackState(tenure, summary({ badges }));
    expect(state.earned).toBe(5);
    expect(state.complete).toBe(false);
  });

  it("completes when every badge is earned", () => {
    const state = trackState(tenure, summary({ badges: award("tenure") }));
    expect(state).toEqual({ earned: 6, total: 6, complete: true });
  });

  it("completes the manor track when platinum is earned", () => {
    expect(trackState(manor, summary()).complete).toBe(false);
    expect(
      trackState(manor, summary({ badges: { platinum: AT(1) } })).complete,
    ).toBe(true);
  });
});

describe("earnedTitles", () => {
  it("is empty until a track is complete", () => {
    expect(earnedTitles(summary())).toEqual([]);
  });

  it("orders titles by completion time, using the latest award", () => {
    const badges = {
      ...award("tenure", { start: 10 }), // complete at the 15th
      ...award("staff", { start: 1 }), // would complete at the 12th
      // one late staff badge pushes its completion past tenure
      extinction: AT(20),
    };
    const titles = earnedTitles(summary({ badges }));
    expect(titles.map((t) => t.section)).toEqual(["tenure", "staff"]);
    expect(titles[0]).toEqual({
      section: "tenure",
      title: tenure.title,
      at: AT(15),
    });
    expect(titles[1]).toEqual({
      section: "staff",
      title: staff.title,
      at: AT(20),
    });
  });
});

describe("STARTER_TITLES", () => {
  it("are unique and never collide with a track title", () => {
    expect(new Set(STARTER_TITLES).size).toBe(STARTER_TITLES.length);
    const trackTitles = new Set(BADGE_SECTIONS.map((s) => s.title));
    for (const title of STARTER_TITLES) {
      expect(trackTitles.has(title)).toBe(false);
    }
  });
});

describe("tierTally", () => {
  it("counts earned against total per tier", () => {
    const empty = tierTally(summary());
    expect(empty.platinum).toEqual({ got: 0, of: 1 });
    const total = Object.values(empty).reduce((n, t) => n + t.of, 0);
    expect(total).toBe(BADGE_META.length);

    const some = tierTally(
      summary({ badges: { "first-blood": AT(1), platinum: AT(2) } }),
    );
    expect(some.bronze.got).toBe(1);
    expect(some.platinum.got).toBe(1);
    expect(some.gold.got).toBe(0);
  });
});

describe("platinum", () => {
  it("reports progress as other badges earned over other total", () => {
    const plat = BADGE_META.find((b) => b.id === "platinum")!;
    expect(plat.progress(summary())).toEqual({ current: 0, target: 39 });
    expect(
      plat.progress(
        summary({ badges: { "first-blood": AT(1), platinum: AT(2) } }),
      ),
    ).toEqual({ current: 1, target: 39 });
  });
});
