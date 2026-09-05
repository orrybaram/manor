import { describe, it, expect } from "vitest";

import { BADGES, evaluateBadges, type BadgeDef } from "../stats-badges";
import type { StatsSummary } from "../stats-store";

function summary(overrides: Partial<StatsSummary> = {}): StatsSummary {
  return {
    today: {},
    last7Days: {},
    allTime: {},
    streakDays: 0,
    badges: {},
    enabled: true,
    ...overrides,
  };
}

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
  "week-streak": summary({ streakDays: 7 }),
  "month-streak": summary({ streakDays: 30 }),
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
  "week-streak": summary({ streakDays: 6 }),
  "month-streak": summary({ streakDays: 29 }),
};

describe("BADGES", () => {
  it("has exactly the twelve v1 badges in ADR order", () => {
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

  it("reads missing bucket fields as zero rather than throwing", () => {
    const empty = summary();
    for (const badge of BADGES) {
      expect(() => badge.earned(empty)).not.toThrow();
      expect(badge.earned(empty)).toBe(false);
    }
  });
});

describe("evaluateBadges", () => {
  it("returns every earned badge when none are awarded yet", () => {
    const allEarned = summary({
      today: { subagents: 10, prompts: 100 },
      allTime: {
        agentsKilled: 100,
        maxConcurrentAgents: 5,
        fastUnblocks: 25,
        worktreesCreated: 50,
        worktreesRemoved: 50,
        worktreesMerged: 10,
      },
      streakDays: 30,
    });
    const result = evaluateBadges(allEarned, {});
    expect(result.map((b) => b.id)).toEqual(BADGES.map((b) => b.id));
  });

  it("skips already-awarded ids and preserves BADGES order", () => {
    const allEarned = summary({
      today: { subagents: 10, prompts: 100 },
      allTime: {
        agentsKilled: 100,
        maxConcurrentAgents: 5,
        fastUnblocks: 25,
        worktreesCreated: 50,
        worktreesRemoved: 50,
        worktreesMerged: 10,
      },
      streakDays: 30,
    });
    const awarded = { massacre: "2026-01-01T00:00:00.000Z", shipper: "2026-01-01T00:00:00.000Z" };
    const result = evaluateBadges(allEarned, awarded);
    expect(result.map((b) => b.id)).toEqual(
      BADGES.map((b) => b.id).filter((id) => id !== "massacre" && id !== "shipper"),
    );
  });

  it("returns an empty array when nothing is earned", () => {
    expect(evaluateBadges(summary(), {})).toEqual([]);
  });
});
