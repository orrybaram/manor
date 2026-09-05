import type { StatsSummary } from "./stats-store";

/**
 * Milestone badges (ADR-168 §4). Pure and Electron-free so the predicates are
 * unit-testable without a `StatsStore`. `StatsStore` runs `evaluateBadges`
 * once per commit and persists newly-earned ids; badges are never revoked.
 *
 * Keep the id/title/description of every badge in sync with the renderer
 * mirror at `src/lib/badges.ts`.
 */

export interface BadgeDef {
  id: string;
  title: string;
  description: string;
  earned: (s: StatsSummary) => boolean;
}

export const BADGES: readonly BadgeDef[] = [
  {
    id: "first-blood",
    title: "First Blood",
    description: "Killed your first agent mid-thought.",
    earned: (s) => (s.allTime.agentsKilled ?? 0) >= 1,
  },
  {
    id: "executioner",
    title: "Executioner",
    description: "Killed 25 agents.",
    earned: (s) => (s.allTime.agentsKilled ?? 0) >= 25,
  },
  {
    id: "massacre",
    title: "Massacre",
    description: "Killed 100 agents.",
    earned: (s) => (s.allTime.agentsKilled ?? 0) >= 100,
  },
  {
    id: "delegator",
    title: "Delegator",
    description: "Spawned 10 subagents in a single day.",
    earned: (s) => (s.today.subagents ?? 0) >= 10,
  },
  {
    id: "swarm",
    title: "Swarm",
    description: "Ran 5 agents at once.",
    earned: (s) => (s.allTime.maxConcurrentAgents ?? 0) >= 5,
  },
  {
    id: "quick-draw",
    title: "Quick Draw",
    description: "Unblocked a waiting agent in under 10 seconds, 25 times.",
    earned: (s) => (s.allTime.fastUnblocks ?? 0) >= 25,
  },
  {
    id: "gardener",
    title: "Gardener",
    description: "Created 50 worktrees.",
    earned: (s) => (s.allTime.worktreesCreated ?? 0) >= 50,
  },
  {
    id: "reaper",
    title: "Reaper",
    description: "Removed 50 worktrees.",
    earned: (s) => (s.allTime.worktreesRemoved ?? 0) >= 50,
  },
  {
    id: "shipper",
    title: "Shipper",
    description: "Quick-merged 10 worktrees.",
    earned: (s) => (s.allTime.worktreesMerged ?? 0) >= 10,
  },
  {
    id: "centurion",
    title: "Centurion",
    description: "Sent 100 prompts in a single day.",
    earned: (s) => (s.today.prompts ?? 0) >= 100,
  },
  {
    id: "week-streak",
    title: "Seven Days",
    description: "Prompted an agent seven days in a row.",
    earned: (s) => s.streakDays >= 7,
  },
  {
    id: "month-streak",
    title: "Thirty Days",
    description: "Prompted an agent thirty days in a row.",
    earned: (s) => s.streakDays >= 30,
  },
];

/**
 * Newly-earned badges: satisfy their predicate and are not already in
 * `awarded`. Returned in `BADGES` order.
 */
export function evaluateBadges(
  summary: StatsSummary,
  awarded: Record<string, string>,
): BadgeDef[] {
  return BADGES.filter((badge) => awarded[badge.id] === undefined && badge.earned(summary));
}
