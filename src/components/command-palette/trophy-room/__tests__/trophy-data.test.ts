import { describe, it, expect } from "vitest";
import type { StatsSummary } from "../../../../electron.d";
import {
  BADGE_SECTIONS,
  STARTER_TITLES,
  earnedTitles,
} from "../../../../lib/badges";
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

const staff = BADGE_SECTIONS.find((s) => s.id === "staff")!;
const tenure = BADGE_SECTIONS.find((s) => s.id === "tenure")!;

/** Completes tenure: every badge in the track earned. */
const TENURE_COMPLETE = {
  "week-streak": AT(1),
  "month-streak": AT(3),
  regular: AT(4),
  devoted: AT(2),
  "half-year": AT(5),
  "year-round": AT(6),
};

describe("trackEntries", () => {
  it("orders by tier, then by target, earned or not", () => {
    const entries = trackEntries(
      tenure,
      summary({ streakWeeks: 10, badges: { "week-streak": AT(5) } }),
    );
    expect(entries.map((e) => e.badge.id)).toEqual([
      "week-streak",
      "regular",
      "month-streak",
      "half-year",
      "year-round",
      "devoted",
    ]);
    expect(entries[0].ratio).toBe(1);
  });
});

describe("isHiddenSecret", () => {
  it("hides a locked secret until it is revealed or earned", () => {
    const locked = trackEntries(staff, summary()).find(
      (e) => e.badge.id === "cold-blooded",
    )!;
    expect(isHiddenSecret(locked, new Set())).toBe(true);
    expect(isHiddenSecret(locked, new Set(["cold-blooded"]))).toBe(false);

    const earned = trackEntries(
      staff,
      summary({ badges: { "cold-blooded": AT(1) } }),
    ).find((e) => e.badge.id === "cold-blooded")!;
    expect(isHiddenSecret(earned, new Set())).toBe(false);
  });
});

describe("displayedTitle", () => {
  it("falls back to the first starter title with no track complete", () => {
    const none = earnedTitles(summary());
    expect(displayedTitle(none, null)).toBe(STARTER_TITLES[0]);
    expect(displayedTitle(none, "Old Guard")).toBe(STARTER_TITLES[0]);
    expect(displayedTitle(none, "Unknown")).toBe(STARTER_TITLES[0]);
  });

  it("uses a chosen starter title", () => {
    expect(displayedTitle(earnedTitles(summary()), STARTER_TITLES[2])).toBe(
      STARTER_TITLES[2],
    );
  });

  it("uses the chosen title while it is earned, else the latest", () => {
    const titles = earnedTitles(
      summary({
        badges: {
          ...TENURE_COMPLETE,
          // The manor track completes on platinum alone, later than tenure.
          platinum: AT(9),
        },
      }),
    );
    expect(displayedTitle(titles, null)).toBe("Lord of the Manor");
    expect(displayedTitle(titles, "Old Guard")).toBe("Old Guard");
    expect(displayedTitle(titles, "Master of the House")).toBe(
      "Lord of the Manor",
    );
    expect(displayedTitle(titles, STARTER_TITLES[1])).toBe(STARTER_TITLES[1]);
  });

  it("drops a title saved from the retired nine tracks", () => {
    const titles = earnedTitles(summary({ badges: TENURE_COMPLETE }));
    for (const old of ["Exterminator", "Warlord", "Faithful", "Platinum"]) {
      expect(displayedTitle(titles, old)).toBe("Old Guard");
      expect(displayedTitle([], old)).toBe(STARTER_TITLES[0]);
    }
  });
});

describe("nextUp", () => {
  it("skips complete tracks and secrets, closest first", () => {
    const s = summary({
      allTime: { prompts: 900, prChangesRequested: 9 },
      streakWeeks: 60,
      badges: TENURE_COMPLETE,
    });
    const ids = nextUp(s).map((e) => e.badge.id);
    expect(ids).not.toContain("year-round");
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
