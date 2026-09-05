/**
 * Renderer mirror of the badge catalogue (ADR-168 §4).
 *
 * Keep in sync with `electron/stats-badges.ts` — same ids, titles,
 * descriptions and order. The renderer cannot import from `electron/`, and the
 * predicates live in main anyway (main decides what is earned), so only the
 * display metadata is duplicated here. `src/lib/__tests__/badges.test.ts`
 * guards the id list.
 */
export interface BadgeMeta {
  id: string;
  title: string;
  description: string;
}

export const BADGE_META: readonly BadgeMeta[] = [
  {
    id: "first-blood",
    title: "First Blood",
    description: "Killed your first agent mid-thought.",
  },
  {
    id: "executioner",
    title: "Executioner",
    description: "Killed 25 agents.",
  },
  {
    id: "massacre",
    title: "Massacre",
    description: "Killed 100 agents.",
  },
  {
    id: "delegator",
    title: "Delegator",
    description: "Spawned 10 subagents in a single day.",
  },
  {
    id: "swarm",
    title: "Swarm",
    description: "Ran 5 agents at once.",
  },
  {
    id: "quick-draw",
    title: "Quick Draw",
    description: "Unblocked a waiting agent in under 10 seconds, 25 times.",
  },
  {
    id: "gardener",
    title: "Gardener",
    description: "Created 50 worktrees.",
  },
  {
    id: "reaper",
    title: "Reaper",
    description: "Removed 50 worktrees.",
  },
  {
    id: "shipper",
    title: "Shipper",
    description: "Quick-merged 10 worktrees.",
  },
  {
    id: "centurion",
    title: "Centurion",
    description: "Sent 100 prompts in a single day.",
  },
  {
    id: "week-streak",
    title: "Seven Days",
    description: "Prompted an agent seven days in a row.",
  },
  {
    id: "month-streak",
    title: "Thirty Days",
    description: "Prompted an agent thirty days in a row.",
  },
];
