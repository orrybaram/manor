import type { StatsSummary } from "../electron.d";

/**
 * Renderer mirror of the badge catalogue (ADR-168 §4).
 *
 * Keep in sync with `electron/stats-badges.ts` — same ids, titles,
 * descriptions, order and thresholds. The renderer cannot import from
 * `electron/`, and the predicates live in main anyway (main decides what is
 * earned), so this copy carries only display metadata plus the `progress`
 * readout used to draw the "23 / 25" bar on a locked achievement.
 * `src/lib/__tests__/badges.test.ts` guards the id list and the thresholds.
 */

/**
 * Difficulty tier, in the Bronze/Silver/Gold idiom console achievement racks
 * use. Purely cosmetic: it sorts the rack and tints the medal frame.
 */
export type BadgeTier = "bronze" | "silver" | "gold";

/** Where a locked badge stands against its unlock threshold. */
export interface BadgeProgress {
  current: number;
  target: number;
}

export interface BadgeMeta {
  id: string;
  title: string;
  description: string;
  /** Emoji shown on the medal once the badge is earned. */
  icon: string;
  /** Accent colour for the earned medal, as an `r g b` triple for `rgb()`. */
  color: string;
  tier: BadgeTier;
  /**
   * Progress toward the unlock, mirroring the predicate in
   * `electron/stats-badges.ts`. `current` is uncapped — clamp at the call site.
   */
  progress: (summary: StatsSummary) => BadgeProgress;
}

/** `bucket[key] ?? 0` against `target`, the shape most predicates take. */
function counter(
  bucket: keyof Pick<StatsSummary, "today" | "last7Days" | "allTime">,
  key: keyof StatsSummary["allTime"],
  target: number,
): (summary: StatsSummary) => BadgeProgress {
  return (summary) => ({ current: summary[bucket][key] ?? 0, target });
}

export const BADGE_META: readonly BadgeMeta[] = [
  {
    id: "first-blood",
    title: "First Blood",
    description: "Killed your first agent mid-thought.",
    icon: "🩸",
    color: "232 93 117",
    tier: "bronze",
    progress: counter("allTime", "agentsKilled", 1),
  },
  {
    id: "executioner",
    title: "Executioner",
    description: "Killed 25 agents.",
    icon: "⚔️",
    color: "224 108 88",
    tier: "silver",
    progress: counter("allTime", "agentsKilled", 25),
  },
  {
    id: "massacre",
    title: "Massacre",
    description: "Killed 100 agents.",
    icon: "💀",
    color: "198 84 168",
    tier: "gold",
    progress: counter("allTime", "agentsKilled", 100),
  },
  {
    id: "delegator",
    title: "Delegator",
    description: "Spawned 10 subagents in a single day.",
    icon: "🧮",
    color: "116 148 240",
    tier: "silver",
    progress: counter("today", "subagents", 10),
  },
  {
    id: "swarm",
    title: "Swarm",
    description: "Ran 5 agents at once.",
    icon: "🐝",
    color: "232 176 68",
    tier: "bronze",
    progress: counter("allTime", "maxConcurrentAgents", 5),
  },
  {
    id: "quick-draw",
    title: "Quick Draw",
    description: "Unblocked a waiting agent in under a minute, 25 times.",
    icon: "⚡",
    color: "240 200 64",
    tier: "silver",
    progress: counter("allTime", "fastUnblocks", 25),
  },
  {
    id: "gardener",
    title: "Gardener",
    description: "Created 50 worktrees.",
    icon: "🌱",
    color: "96 190 120",
    tier: "silver",
    progress: counter("allTime", "worktreesCreated", 50),
  },
  {
    id: "reaper",
    title: "Reaper",
    description: "Removed 50 worktrees.",
    icon: "🍂",
    color: "180 148 96",
    tier: "silver",
    progress: counter("allTime", "worktreesRemoved", 50),
  },
  {
    id: "shipper",
    title: "Shipper",
    description: "Shipped 10 workspaces, by quick merge or a merged PR.",
    icon: "🚀",
    color: "88 176 224",
    tier: "bronze",
    progress: (summary) => ({
      current:
        (summary.allTime.worktreesMerged ?? 0) +
        (summary.allTime.prsMerged ?? 0),
      target: 10,
    }),
  },
  {
    id: "centurion",
    title: "Centurion",
    description: "Sent 100 prompts in a single day.",
    icon: "🏛️",
    color: "204 168 100",
    tier: "gold",
    progress: counter("today", "prompts", 100),
  },
  {
    id: "week-streak",
    title: "Seven Days",
    description: "Prompted an agent seven days in a row.",
    icon: "🔥",
    color: "236 140 72",
    tier: "silver",
    progress: (summary) => ({ current: summary.streakDays, target: 7 }),
  },
  {
    id: "month-streak",
    title: "Thirty Days",
    description: "Prompted an agent thirty days in a row.",
    icon: "🌟",
    color: "160 132 236",
    tier: "gold",
    progress: (summary) => ({ current: summary.streakDays, target: 30 }),
  },
];

/** Rack ordering: rarest tier last, so the easy wins read first. */
export const TIER_ORDER: Record<BadgeTier, number> = {
  bronze: 0,
  silver: 1,
  gold: 2,
};

/** Human label for the tier chip on a medal. */
export const TIER_LABEL: Record<BadgeTier, string> = {
  bronze: "Bronze",
  silver: "Silver",
  gold: "Gold",
};

/** 0–1 completion for a locked badge, clamped. */
export function progressRatio(p: BadgeProgress): number {
  if (p.target <= 0) return 1;
  return Math.min(1, Math.max(0, p.current / p.target));
}
