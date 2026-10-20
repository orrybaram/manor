import { describe, it, expect } from "vitest";

import { BADGES, evaluateBadges, type BadgeDef } from "../stats-badges";
import type { StatsSummary } from "../stats-store";

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

/** `count` distinct days with one prompt each, for the active-days badges. */
function days(count: number): StatsSummary["dailyPrompts"] {
  return Array.from({ length: count }, (_, i) => ({
    day: `day-${i}`,
    count: 1,
  }));
}

/** Every badge id but platinum, awarded — what platinum reads. */
const OTHER_IDS = BADGES.map((b) => b.id).filter((id) => id !== "platinum");
const ALL_OTHERS_AWARDED = Object.fromEntries(
  OTHER_IDS.map((id) => [id, "2026-01-01T00:00:00.000Z"]),
);

/** Table of `[badgeId, thresholdSummary]` — the smallest summary that flips it on. */
const THRESHOLDS: Record<string, StatsSummary> = {
  "first-blood": summary({ allTime: { agentsKilled: 1 } }),
  executioner: summary({ allTime: { agentsKilled: 25 } }),
  massacre: summary({ allTime: { agentsKilled: 100 } }),
  delegator: summary({ today: { subagents: 10 } }),
  swarm: summary({ allTime: { maxConcurrentAgents: 5 } }),
  "quick-draw": summary({ allTime: { fastUnblocks: 25 } }),
  gardener: summary({ allTime: { worktreesCreated: 50 } }),
  reaper: summary({ allTime: { worktreesRemoved: 50 } }),
  shipper: summary({ allTime: { worktreesMerged: 10 } }),
  centurion: summary({ today: { prompts: 100 } }),
  "week-streak": summary({ streakWeeks: 4 }),
  "month-streak": summary({ streakWeeks: 12 }),
  "cold-blooded": summary({ allTime: { agentsKilledMidThought: 25 } }),
  extinction: summary({ allTime: { agentsKilled: 500 } }),
  chatterbox: summary({ allTime: { prompts: 1000 } }),
  novelist: summary({ allTime: { prompts: 10_000 } }),
  marathon: summary({ today: { prompts: 250 } }),
  regular: summary({ dailyPrompts: days(100) }),
  devoted: summary({ dailyPrompts: days(300) }),
  "half-year": summary({ streakWeeks: 26 }),
  "year-round": summary({ streakWeeks: 52 }),
  "busy-hands": summary({ allTime: { toolCalls: 10_000 } }),
  industrious: summary({ allTime: { toolCalls: 100_000 } }),
  overclocked: summary({ today: { toolCalls: 1000 } }),
  "hive-mind": summary({ allTime: { maxConcurrentAgents: 10 } }),
  summoner: summary({ allTime: { agentSessions: 500 } }),
  recruiter: summary({ allTime: { subagents: 1000 } }),
  legion: summary({ today: { subagents: 100 } }),
  "good-listener": summary({ allTime: { agentsResponded: 1000 } }),
  gatekeeper: summary({ allTime: { unblocks: 500 } }),
  lightning: summary({ allTime: { fastUnblocks: 250 } }),
  forester: summary({ allTime: { worktreesCreated: 250 } }),
  "scorched-earth": summary({ allTime: { worktreesRemoved: 250 } }),
  fleet: summary({ allTime: { worktreesMerged: 50 } }),
  armada: summary({ allTime: { worktreesMerged: 200 } }),
  "hot-streak": summary({ today: { prsMerged: 5 } }),
  "seal-of-approval": summary({ allTime: { prApproved: 10 } }),
  "red-ink": summary({ allTime: { prChangesRequested: 10 } }),
  "works-on-my-machine": summary({ allTime: { prChecksFailed: 25 } }),
  platinum: summary({ badges: ALL_OTHERS_AWARDED }),
};

/** One below each badge's threshold — the predicate must still read false. */
const BELOW_THRESHOLDS: Record<string, StatsSummary> = {
  "first-blood": summary({ allTime: { agentsKilled: 0 } }),
  executioner: summary({ allTime: { agentsKilled: 24 } }),
  massacre: summary({ allTime: { agentsKilled: 99 } }),
  delegator: summary({ today: { subagents: 9 } }),
  swarm: summary({ allTime: { maxConcurrentAgents: 4 } }),
  "quick-draw": summary({ allTime: { fastUnblocks: 24 } }),
  gardener: summary({ allTime: { worktreesCreated: 49 } }),
  reaper: summary({ allTime: { worktreesRemoved: 49 } }),
  shipper: summary({ allTime: { worktreesMerged: 9 } }),
  centurion: summary({ today: { prompts: 99 } }),
  "week-streak": summary({ streakWeeks: 3 }),
  "month-streak": summary({ streakWeeks: 11 }),
  "cold-blooded": summary({ allTime: { agentsKilledMidThought: 24 } }),
  extinction: summary({ allTime: { agentsKilled: 499 } }),
  chatterbox: summary({ allTime: { prompts: 999 } }),
  novelist: summary({ allTime: { prompts: 9999 } }),
  marathon: summary({ today: { prompts: 249 } }),
  regular: summary({ dailyPrompts: days(99) }),
  devoted: summary({ dailyPrompts: days(299) }),
  "half-year": summary({ streakWeeks: 25 }),
  "year-round": summary({ streakWeeks: 51 }),
  "busy-hands": summary({ allTime: { toolCalls: 9999 } }),
  industrious: summary({ allTime: { toolCalls: 99_999 } }),
  overclocked: summary({ today: { toolCalls: 999 } }),
  "hive-mind": summary({ allTime: { maxConcurrentAgents: 9 } }),
  summoner: summary({ allTime: { agentSessions: 499 } }),
  recruiter: summary({ allTime: { subagents: 999 } }),
  legion: summary({ today: { subagents: 99 } }),
  "good-listener": summary({ allTime: { agentsResponded: 999 } }),
  gatekeeper: summary({ allTime: { unblocks: 499 } }),
  lightning: summary({ allTime: { fastUnblocks: 249 } }),
  forester: summary({ allTime: { worktreesCreated: 249 } }),
  "scorched-earth": summary({ allTime: { worktreesRemoved: 249 } }),
  fleet: summary({ allTime: { worktreesMerged: 49 } }),
  armada: summary({ allTime: { worktreesMerged: 199 } }),
  "hot-streak": summary({ today: { prsMerged: 4 } }),
  "seal-of-approval": summary({ allTime: { prApproved: 9 } }),
  "red-ink": summary({ allTime: { prChangesRequested: 9 } }),
  "works-on-my-machine": summary({ allTime: { prChecksFailed: 24 } }),
  platinum: summary({
    badges: Object.fromEntries(
      Object.entries(ALL_OTHERS_AWARDED).slice(1),
    ),
  }),
};

describe("BADGES", () => {
  it("has every badge in catalogue order", () => {
    expect(BADGES.map((b) => b.id)).toEqual([
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
    ]);
  });

  it("has unique ids", () => {
    const ids = BADGES.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has a non-empty title and description for every badge", () => {
    for (const badge of BADGES) {
      expect(badge.title.length).toBeGreaterThan(0);
      expect(badge.description.length).toBeGreaterThan(0);
    }
  });

  it.each(BADGES.map((b) => b.id))("%s flips at its threshold", (id) => {
    const badge = BADGES.find((b) => b.id === id) as BadgeDef;
    expect(badge.earned(BELOW_THRESHOLDS[id])).toBe(false);
    expect(badge.earned(THRESHOLDS[id])).toBe(true);
  });

  it("counts quick merges and merged PRs together for shipper", () => {
    const shipper = BADGES.find((b) => b.id === "shipper") as BadgeDef;
    expect(shipper.earned(summary({ allTime: { prsMerged: 10 } }))).toBe(true);
    expect(
      shipper.earned(summary({ allTime: { worktreesMerged: 4, prsMerged: 5 } })),
    ).toBe(false);
    expect(
      shipper.earned(summary({ allTime: { worktreesMerged: 4, prsMerged: 6 } })),
    ).toBe(true);
  });

  it("reads missing bucket fields as zero rather than throwing", () => {
    const empty = summary();
    for (const badge of BADGES) {
      expect(() => badge.earned(empty)).not.toThrow();
      expect(badge.earned(empty)).toBe(false);
    }
  });
});

/** Clears every badge's threshold at once. */
const allEarned = summary({
  today: { subagents: 100, prompts: 250, toolCalls: 1_000, prsMerged: 5 },
  allTime: {
    agentsKilled: 500,
    agentsKilledMidThought: 25,
    prompts: 10_000,
    toolCalls: 100_000,
    agentSessions: 500,
    subagents: 1_000,
    agentsResponded: 1_000,
    maxConcurrentAgents: 10,
    unblocks: 500,
    fastUnblocks: 250,
    worktreesCreated: 250,
    worktreesRemoved: 250,
    worktreesMerged: 200,
    prApproved: 10,
    prChangesRequested: 10,
    prChecksFailed: 25,
  },
  dailyPrompts: days(300),
  streakWeeks: 52,
});

describe("evaluateBadges", () => {
  it("returns every earned badge when none are awarded yet", () => {
    const result = evaluateBadges(allEarned, {});
    expect(result.map((b) => b.id)).toEqual(OTHER_IDS);
  });

  it("awards platinum on the evaluation after the last other badge", () => {
    const awarded = ALL_OTHERS_AWARDED;
    const result = evaluateBadges({ ...allEarned, badges: awarded }, awarded);
    expect(result.map((b) => b.id)).toEqual(["platinum"]);
  });

  it("skips already-awarded ids and preserves BADGES order", () => {
    const awarded = { massacre: "2026-01-01T00:00:00.000Z", shipper: "2026-01-01T00:00:00.000Z" };
    const result = evaluateBadges(allEarned, awarded);
    expect(result.map((b) => b.id)).toEqual(
      OTHER_IDS.filter((id) => id !== "massacre" && id !== "shipper"),
    );
  });

  it("returns an empty array when nothing is earned", () => {
    expect(evaluateBadges(summary(), {})).toEqual([]);
  });
});
