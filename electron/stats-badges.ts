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
    description: "Unblocked a waiting agent in under a minute, 25 times.",
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
    description: "Shipped 10 workspaces, by quick merge or a merged PR.",
    earned: (s) => shipped(s) >= 10,
  },
  {
    id: "centurion",
    title: "Centurion",
    description: "Sent 100 prompts in a single day.",
    earned: (s) => (s.today.prompts ?? 0) >= 100,
  },
  // Streaks count active weeks, not days. The ids predate that and stay as
  // they are, so badges already awarded under the day rules still show.
  {
    id: "week-streak",
    title: "Four Weeks",
    description: "Prompted an agent four weeks in a row.",
    earned: (s) => s.streakWeeks >= 4,
  },
  {
    id: "month-streak",
    title: "Twelve Weeks",
    description: "Prompted an agent twelve weeks in a row.",
    earned: (s) => s.streakWeeks >= 12,
  },
  {
    id: "cold-blooded",
    title: "Cold Blooded",
    description: "Killed 25 agents mid-thought.",
    earned: (s) => (s.allTime.agentsKilledMidThought ?? 0) >= 25,
  },
  {
    id: "extinction",
    title: "Extinction Event",
    description: "Killed 500 agents.",
    earned: (s) => (s.allTime.agentsKilled ?? 0) >= 500,
  },
  {
    id: "chatterbox",
    title: "Chatterbox",
    description: "Sent 1,000 prompts.",
    earned: (s) => (s.allTime.prompts ?? 0) >= 1000,
  },
  {
    id: "novelist",
    title: "Novelist",
    description: "Sent 10,000 prompts.",
    earned: (s) => (s.allTime.prompts ?? 0) >= 10_000,
  },
  {
    id: "marathon",
    title: "Marathon",
    description: "Sent 250 prompts in a single day.",
    earned: (s) => (s.today.prompts ?? 0) >= 250,
  },
  {
    id: "regular",
    title: "Regular",
    description: "Prompted an agent on 100 different days.",
    earned: (s) => s.dailyPrompts.length >= 100,
  },
  {
    id: "devoted",
    title: "Devoted",
    description: "Prompted an agent on 300 different days.",
    earned: (s) => s.dailyPrompts.length >= 300,
  },
  {
    id: "half-year",
    title: "Half Year",
    description: "Prompted an agent 26 weeks in a row.",
    earned: (s) => s.streakWeeks >= 26,
  },
  {
    id: "year-round",
    title: "Year Round",
    description: "Prompted an agent 52 weeks in a row.",
    earned: (s) => s.streakWeeks >= 52,
  },
  {
    id: "busy-hands",
    title: "Busy Hands",
    description: "Agents made 10,000 tool calls.",
    earned: (s) => (s.allTime.toolCalls ?? 0) >= 10_000,
  },
  {
    id: "industrious",
    title: "Industrious",
    description: "Agents made 100,000 tool calls.",
    earned: (s) => (s.allTime.toolCalls ?? 0) >= 100_000,
  },
  {
    id: "overclocked",
    title: "Overclocked",
    description: "Agents made 1,000 tool calls in a single day.",
    earned: (s) => (s.today.toolCalls ?? 0) >= 1000,
  },
  {
    id: "hive-mind",
    title: "Hive Mind",
    description: "Ran 10 agents at once.",
    earned: (s) => (s.allTime.maxConcurrentAgents ?? 0) >= 10,
  },
  {
    id: "summoner",
    title: "Summoner",
    description: "Started 500 agent sessions.",
    earned: (s) => (s.allTime.agentSessions ?? 0) >= 500,
  },
  {
    id: "recruiter",
    title: "Recruiter",
    description: "Spawned 1,000 subagents.",
    earned: (s) => (s.allTime.subagents ?? 0) >= 1000,
  },
  {
    id: "legion",
    title: "Legion",
    description: "Spawned 100 subagents in a single day.",
    earned: (s) => (s.today.subagents ?? 0) >= 100,
  },
  {
    id: "good-listener",
    title: "Good Listener",
    description: "Agents finished 1,000 turns.",
    earned: (s) => (s.allTime.agentsResponded ?? 0) >= 1000,
  },
  {
    id: "gatekeeper",
    title: "Gatekeeper",
    description: "Answered 500 agents waiting on you.",
    earned: (s) => (s.allTime.unblocks ?? 0) >= 500,
  },
  {
    id: "lightning",
    title: "Lightning",
    description: "Unblocked a waiting agent in under a minute, 250 times.",
    earned: (s) => (s.allTime.fastUnblocks ?? 0) >= 250,
  },
  {
    id: "forester",
    title: "Forester",
    description: "Created 250 worktrees.",
    earned: (s) => (s.allTime.worktreesCreated ?? 0) >= 250,
  },
  {
    id: "scorched-earth",
    title: "Scorched Earth",
    description: "Removed 250 worktrees.",
    earned: (s) => (s.allTime.worktreesRemoved ?? 0) >= 250,
  },
  {
    id: "fleet",
    title: "Fleet",
    description: "Shipped 50 workspaces.",
    earned: (s) => shipped(s) >= 50,
  },
  {
    id: "armada",
    title: "Armada",
    description: "Shipped 200 workspaces.",
    earned: (s) => shipped(s) >= 200,
  },
  {
    id: "hot-streak",
    title: "Hot Streak",
    description: "Merged 5 PRs in a single day.",
    earned: (s) => (s.today.prsMerged ?? 0) >= 5,
  },
  {
    id: "seal-of-approval",
    title: "Seal of Approval",
    description: "Had 10 PRs approved.",
    earned: (s) => (s.allTime.prApproved ?? 0) >= 10,
  },
  {
    id: "red-ink",
    title: "Red Ink",
    description: "Had changes requested on 10 PRs.",
    earned: (s) => (s.allTime.prChangesRequested ?? 0) >= 10,
  },
  {
    id: "works-on-my-machine",
    title: "Works on My Machine",
    description: "Had CI fail on 25 PRs.",
    earned: (s) => (s.allTime.prChecksFailed ?? 0) >= 25,
  },
  // Reads `s.badges`, so it lands on the commit after the last other badge.
  {
    id: "platinum",
    title: "Lord of the Manor",
    description: "Earned every other badge.",
    earned: (s) =>
      BADGES.every((b) => b.id === "platinum" || s.badges[b.id] !== undefined),
  },
];

/**
 * Workspaces that reached the base branch, however they got there: Manor's
 * quick merge, or a pull request GitHub reports as merged. The two paths are
 * counted separately (a quick merge never touches GitHub, and a PR merge
 * outlives the workspace) but they mean the same thing to Shipper.
 */
export function shipped(s: StatsSummary): number {
  return (s.allTime.worktreesMerged ?? 0) + (s.allTime.prsMerged ?? 0);
}

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
