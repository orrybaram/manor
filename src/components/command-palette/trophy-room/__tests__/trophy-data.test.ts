import { describe, it, expect } from "vitest";
import type { StatsSummary } from "../../../../electron.d";
import { BADGE_SECTIONS } from "../../../../lib/badges";
import {
  displayedTitle,
  isHiddenSecret,
  nextUp,
  recentUnlocks,
  trackEntries,
} from "../trophy-data";

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

const AT = (day: number) =>
  `2026-01-${String(day).padStart(2, "0")}T00:00:00.000Z`;

const carnage = BADGE_SECTIONS.find((s) => s.id === "carnage")!;

/** Seals carnage: every non-gild badge earned. */
const CARNAGE_SEAL = {
  "first-blood": AT(1),
  executioner: AT(3),
  "cold-blooded": AT(2),
};

describe("trackEntries", () => {
  it("splits the gild set out and orders earned by date, then locked by progress", () => {
    const { base, gild } = trackEntries(
      carnage,
      summary({
        allTime: { agentsKilled: 20, agentsKilledMidThought: 2 },
        badges: { "first-blood": AT(5) },
      }),
    );
    expect(base.map((e) => e.badge.id)).toEqual([
      "first-blood",
      "executioner",
      "cold-blooded",
    ]);
    expect(gild.map((e) => e.badge.id)).toEqual(["massacre", "extinction"]);
    expect(base[0].ratio).toBe(1);
  });
});

describe("isHiddenSecret", () => {
  it("hides a locked secret until it is revealed or earned", () => {
    const locked = trackEntries(carnage, summary()).base.find(
      (e) => e.badge.id === "cold-blooded",
    )!;
    expect(isHiddenSecret(locked, new Set())).toBe(true);
    expect(isHiddenSecret(locked, new Set(["cold-blooded"]))).toBe(false);

    const earned = trackEntries(
      carnage,
      summary({ badges: { "cold-blooded": AT(1) } }),
    ).base.find((e) => e.badge.id === "cold-blooded")!;
    expect(isHiddenSecret(earned, new Set())).toBe(false);
  });
});

describe("displayedTitle", () => {
  it("is null with nothing sealed", () => {
    expect(displayedTitle(summary(), null)).toBeNull();
  });

  it("uses the chosen title while it is earned, else the latest", () => {
    const s = summary({
      badges: {
        ...CARNAGE_SEAL,
        // Meta seals on platinum alone, later than carnage.
        platinum: AT(9),
      },
    });
    expect(displayedTitle(s, null)?.title).toBe("Platinum");
    expect(displayedTitle(s, "Exterminator")?.title).toBe("Exterminator");
    expect(displayedTitle(s, "Warlord")?.title).toBe("Platinum");
  });
});

describe("nextUp", () => {
  it("skips sealed tracks, secrets and gild badges, closest first", () => {
    const s = summary({
      allTime: { agentsKilled: 99, agentsKilledMidThought: 24, prompts: 900 },
      badges: CARNAGE_SEAL,
    });
    const ids = nextUp(s).map((e) => e.badge.id);
    expect(ids).not.toContain("massacre");
    expect(ids).not.toContain("cold-blooded");
    expect(ids[0]).toBe("chatterbox");
    expect(ids).toHaveLength(3);
  });
});

describe("recentUnlocks", () => {
  it("lists the newest unlocks first, capped", () => {
    const badges: Record<string, string> = {};
    [
      "first-blood",
      "swarm",
      "shipper",
      "chatterbox",
      "regular",
      "fleet",
    ].forEach((id, i) => {
      badges[id] = AT(i + 1);
    });
    const ids = recentUnlocks(summary({ badges })).map((e) => e.badge.id);
    expect(ids).toEqual(["fleet", "regular", "chatterbox", "shipper", "swarm"]);
  });
});
