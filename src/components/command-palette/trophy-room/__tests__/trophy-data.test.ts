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

/** Completes carnage: every badge in the track earned. */
const CARNAGE_COMPLETE = {
  "first-blood": AT(1),
  executioner: AT(3),
  massacre: AT(4),
  "cold-blooded": AT(2),
  extinction: AT(5),
};

describe("trackEntries", () => {
  it("orders earned by date, then locked by progress", () => {
    const entries = trackEntries(
      carnage,
      summary({
        allTime: { agentsKilled: 20, agentsKilledMidThought: 2 },
        badges: { "first-blood": AT(5) },
      }),
    );
    expect(entries.map((e) => e.badge.id)).toEqual([
      "first-blood",
      "executioner",
      "massacre",
      "cold-blooded",
      "extinction",
    ]);
    expect(entries[0].ratio).toBe(1);
  });
});

describe("isHiddenSecret", () => {
  it("hides a locked secret until it is revealed or earned", () => {
    const locked = trackEntries(carnage, summary()).find(
      (e) => e.badge.id === "cold-blooded",
    )!;
    expect(isHiddenSecret(locked, new Set())).toBe(true);
    expect(isHiddenSecret(locked, new Set(["cold-blooded"]))).toBe(false);

    const earned = trackEntries(
      carnage,
      summary({ badges: { "cold-blooded": AT(1) } }),
    ).find((e) => e.badge.id === "cold-blooded")!;
    expect(isHiddenSecret(earned, new Set())).toBe(false);
  });
});

describe("displayedTitle", () => {
  it("is null with no track complete", () => {
    expect(displayedTitle(summary(), null)).toBeNull();
  });

  it("uses the chosen title while it is earned, else the latest", () => {
    const s = summary({
      badges: {
        ...CARNAGE_COMPLETE,
        // Meta completes on platinum alone, later than carnage.
        platinum: AT(9),
      },
    });
    expect(displayedTitle(s, null)?.title).toBe("Platinum");
    expect(displayedTitle(s, "Exterminator")?.title).toBe("Exterminator");
    expect(displayedTitle(s, "Warlord")?.title).toBe("Platinum");
  });
});

describe("nextUp", () => {
  it("skips complete tracks and secrets, closest first", () => {
    const s = summary({
      allTime: { agentsKilled: 500, prompts: 900, prChangesRequested: 9 },
      badges: CARNAGE_COMPLETE,
    });
    const ids = nextUp(s).map((e) => e.badge.id);
    expect(ids).not.toContain("extinction");
    expect(ids).not.toContain("red-ink");
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
