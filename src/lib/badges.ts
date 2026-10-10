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
 * Difficulty tier, in the Bronze/Silver/Gold/Platinum idiom console achievement racks
 * use. Purely cosmetic: it sorts the rack and tints the medal frame.
 */
export type BadgeTier = "bronze" | "silver" | "gold" | "platinum";

/**
 * Progression track a badge belongs to. The rack groups by track so each one
 * reads as a ladder, easiest rung first.
 */
export type BadgeSection =
  | "carnage"
  | "command"
  | "voice"
  | "devotion"
  | "machinery"
  | "reflexes"
  | "groundskeeping"
  | "shipping"
  | "meta";

export interface BadgeSectionMeta {
  id: BadgeSection;
  /** Track name shown in the rack. */
  name: string;
  /** One-line flavour under the section heading. */
  blurb: string;
  /** Reward name earned by completing the track (ADR-212). */
  title: string;
}

/** Sections in rack order. */
export const BADGE_SECTIONS: readonly BadgeSectionMeta[] = [
  {
    id: "carnage",
    name: "Carnage",
    blurb: "Agents you put down.",
    title: "Exterminator",
  },
  {
    id: "command",
    name: "Command",
    blurb: "How many agents you run.",
    title: "Warlord",
  },
  {
    id: "voice",
    name: "Voice",
    blurb: "Prompts you send.",
    title: "Silver Tongue",
  },
  {
    id: "devotion",
    name: "Devotion",
    blurb: "Showing up, week after week.",
    title: "Faithful",
  },
  {
    id: "machinery",
    name: "Machinery",
    blurb: "Tool calls your agents make.",
    title: "Machinist",
  },
  {
    id: "reflexes",
    name: "Reflexes",
    blurb: "Answering agents that wait on you.",
    title: "Gunslinger",
  },
  {
    id: "groundskeeping",
    name: "Groundskeeping",
    blurb: "Worktrees you create and remove.",
    title: "Groundskeeper",
  },
  {
    id: "shipping",
    name: "Shipping",
    blurb: "Work that lands, and the PR reviews and CI runs along the way.",
    title: "Release Captain",
  },
  {
    id: "meta",
    name: "Meta",
    blurb: "Badges about badges.",
    title: "Platinum",
  },
];

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
  section: BadgeSection;
  /** Hidden on screen (`???`) until earned or revealed (ADR-212). */
  secret?: boolean;
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

/** Quick merges plus merged PRs, mirroring `shipped` in main. */
function shipped(summary: StatsSummary): number {
  return (
    (summary.allTime.worktreesMerged ?? 0) + (summary.allTime.prsMerged ?? 0)
  );
}

const PLATINUM_ID = "platinum";

/** Ids the platinum badge counts; filled in once the catalogue is defined. */
const BADGE_META_BASE_IDS: string[] = [];

export const BADGE_META: readonly BadgeMeta[] = [
  {
    id: "first-blood",
    title: "First Blood",
    description: "Killed your first agent mid-thought.",
    icon: "🩸",
    color: "232 93 117",
    tier: "bronze",
    section: "carnage",
    progress: counter("allTime", "agentsKilled", 1),
  },
  {
    id: "executioner",
    title: "Executioner",
    description: "Killed 25 agents.",
    icon: "⚔️",
    color: "224 108 88",
    tier: "silver",
    section: "carnage",
    progress: counter("allTime", "agentsKilled", 25),
  },
  {
    id: "massacre",
    title: "Massacre",
    description: "Killed 100 agents.",
    icon: "💀",
    color: "198 84 168",
    tier: "gold",
    section: "carnage",
    progress: counter("allTime", "agentsKilled", 100),
  },
  {
    id: "delegator",
    title: "Delegator",
    description: "Spawned 10 subagents in a single day.",
    icon: "🧮",
    color: "116 148 240",
    tier: "silver",
    section: "command",
    progress: counter("today", "subagents", 10),
  },
  {
    id: "swarm",
    title: "Swarm",
    description: "Ran 5 agents at once.",
    icon: "🐝",
    color: "232 176 68",
    tier: "bronze",
    section: "command",
    progress: counter("allTime", "maxConcurrentAgents", 5),
  },
  {
    id: "quick-draw",
    title: "Quick Draw",
    description: "Unblocked a waiting agent in under a minute, 25 times.",
    icon: "⚡",
    color: "240 200 64",
    tier: "silver",
    section: "reflexes",
    progress: counter("allTime", "fastUnblocks", 25),
  },
  {
    id: "gardener",
    title: "Gardener",
    description: "Created 50 worktrees.",
    icon: "🌱",
    color: "96 190 120",
    tier: "silver",
    section: "groundskeeping",
    progress: counter("allTime", "worktreesCreated", 50),
  },
  {
    id: "reaper",
    title: "Reaper",
    description: "Removed 50 worktrees.",
    icon: "🍂",
    color: "180 148 96",
    tier: "silver",
    section: "groundskeeping",
    progress: counter("allTime", "worktreesRemoved", 50),
  },
  {
    id: "shipper",
    title: "Shipper",
    description: "Shipped 10 workspaces, by quick merge or a merged PR.",
    icon: "🚀",
    color: "88 176 224",
    tier: "bronze",
    section: "shipping",
    progress: (summary) => ({ current: shipped(summary), target: 10 }),
  },
  {
    id: "centurion",
    title: "Centurion",
    description: "Sent 100 prompts in a single day.",
    icon: "🏛️",
    color: "204 168 100",
    tier: "gold",
    section: "voice",
    progress: counter("today", "prompts", 100),
  },
  {
    id: "week-streak",
    title: "Four Weeks",
    description: "Prompted an agent four weeks in a row.",
    icon: "🔥",
    color: "236 140 72",
    tier: "silver",
    section: "devotion",
    progress: (summary) => ({ current: summary.streakWeeks, target: 4 }),
  },
  {
    id: "month-streak",
    title: "Twelve Weeks",
    description: "Prompted an agent twelve weeks in a row.",
    icon: "🌟",
    color: "160 132 236",
    tier: "gold",
    section: "devotion",
    progress: (summary) => ({ current: summary.streakWeeks, target: 12 }),
  },
  {
    id: "cold-blooded",
    title: "Cold Blooded",
    description: "Killed 25 agents mid-thought.",
    icon: "🧊",
    color: "120 196 232",
    tier: "silver",
    section: "carnage",
    secret: true,
    progress: counter("allTime", "agentsKilledMidThought", 25),
  },
  {
    id: "extinction",
    title: "Extinction Event",
    description: "Killed 500 agents.",
    icon: "☄️",
    color: "214 72 72",
    tier: "gold",
    section: "carnage",
    progress: counter("allTime", "agentsKilled", 500),
  },
  {
    id: "chatterbox",
    title: "Chatterbox",
    description: "Sent 1,000 prompts.",
    icon: "💬",
    color: "150 180 210",
    tier: "bronze",
    section: "voice",
    progress: counter("allTime", "prompts", 1000),
  },
  {
    id: "novelist",
    title: "Novelist",
    description: "Sent 10,000 prompts.",
    icon: "📚",
    color: "184 132 92",
    tier: "gold",
    section: "voice",
    progress: counter("allTime", "prompts", 10_000),
  },
  {
    id: "marathon",
    title: "Marathon",
    description: "Sent 250 prompts in a single day.",
    icon: "🏃",
    color: "232 120 96",
    tier: "gold",
    section: "voice",
    progress: counter("today", "prompts", 250),
  },
  {
    id: "regular",
    title: "Regular",
    description: "Prompted an agent on 100 different days.",
    icon: "☕",
    color: "168 120 88",
    tier: "silver",
    section: "devotion",
    progress: (summary) => ({
      current: summary.dailyPrompts.length,
      target: 100,
    }),
  },
  {
    id: "devoted",
    title: "Devoted",
    description: "Prompted an agent on 300 different days.",
    icon: "🕯️",
    color: "236 196 120",
    tier: "gold",
    section: "devotion",
    progress: (summary) => ({
      current: summary.dailyPrompts.length,
      target: 300,
    }),
  },
  {
    id: "half-year",
    title: "Half Year",
    description: "Prompted an agent 26 weeks in a row.",
    icon: "🌗",
    color: "176 168 220",
    tier: "gold",
    section: "devotion",
    progress: (summary) => ({ current: summary.streakWeeks, target: 26 }),
  },
  {
    id: "year-round",
    title: "Year Round",
    description: "Prompted an agent 52 weeks in a row.",
    icon: "🌍",
    color: "88 168 200",
    tier: "gold",
    section: "devotion",
    progress: (summary) => ({ current: summary.streakWeeks, target: 52 }),
  },
  {
    id: "busy-hands",
    title: "Busy Hands",
    description: "Agents made 10,000 tool calls.",
    icon: "🔧",
    color: "140 156 176",
    tier: "bronze",
    section: "machinery",
    progress: counter("allTime", "toolCalls", 10_000),
  },
  {
    id: "industrious",
    title: "Industrious",
    description: "Agents made 100,000 tool calls.",
    icon: "🏭",
    color: "120 132 148",
    tier: "gold",
    section: "machinery",
    progress: counter("allTime", "toolCalls", 100_000),
  },
  {
    id: "overclocked",
    title: "Overclocked",
    description: "Agents made 1,000 tool calls in a single day.",
    icon: "🌡️",
    color: "236 96 80",
    tier: "silver",
    section: "machinery",
    progress: counter("today", "toolCalls", 1000),
  },
  {
    id: "hive-mind",
    title: "Hive Mind",
    description: "Ran 10 agents at once.",
    icon: "🐜",
    color: "200 140 60",
    tier: "gold",
    section: "command",
    progress: counter("allTime", "maxConcurrentAgents", 10),
  },
  {
    id: "summoner",
    title: "Summoner",
    description: "Started 500 agent sessions.",
    icon: "🔮",
    color: "168 112 220",
    tier: "silver",
    section: "command",
    progress: counter("allTime", "agentSessions", 500),
  },
  {
    id: "recruiter",
    title: "Recruiter",
    description: "Spawned 1,000 subagents.",
    icon: "🪖",
    color: "132 156 100",
    tier: "silver",
    section: "command",
    progress: counter("allTime", "subagents", 1000),
  },
  {
    id: "legion",
    title: "Legion",
    description: "Spawned 100 subagents in a single day.",
    icon: "🛡️",
    color: "100 124 200",
    tier: "gold",
    section: "command",
    progress: counter("today", "subagents", 100),
  },
  {
    id: "good-listener",
    title: "Good Listener",
    description: "Agents finished 1,000 turns.",
    icon: "👂",
    color: "212 168 140",
    tier: "bronze",
    section: "command",
    progress: counter("allTime", "agentsResponded", 1000),
  },
  {
    id: "gatekeeper",
    title: "Gatekeeper",
    description: "Answered 500 agents waiting on you.",
    icon: "🚪",
    color: "176 140 100",
    tier: "silver",
    section: "reflexes",
    progress: counter("allTime", "unblocks", 500),
  },
  {
    id: "lightning",
    title: "Lightning",
    description: "Unblocked a waiting agent in under a minute, 250 times.",
    icon: "🌩️",
    color: "252 220 96",
    tier: "gold",
    section: "reflexes",
    progress: counter("allTime", "fastUnblocks", 250),
  },
  {
    id: "forester",
    title: "Forester",
    description: "Created 250 worktrees.",
    icon: "🌲",
    color: "64 160 96",
    tier: "gold",
    section: "groundskeeping",
    progress: counter("allTime", "worktreesCreated", 250),
  },
  {
    id: "scorched-earth",
    title: "Scorched Earth",
    description: "Removed 250 worktrees.",
    icon: "🔥",
    color: "220 100 48",
    tier: "gold",
    section: "groundskeeping",
    progress: counter("allTime", "worktreesRemoved", 250),
  },
  {
    id: "fleet",
    title: "Fleet",
    description: "Shipped 50 workspaces.",
    icon: "⛵",
    color: "96 160 220",
    tier: "silver",
    section: "shipping",
    progress: (summary) => ({ current: shipped(summary), target: 50 }),
  },
  {
    id: "armada",
    title: "Armada",
    description: "Shipped 200 workspaces.",
    icon: "🚢",
    color: "64 128 200",
    tier: "gold",
    section: "shipping",
    progress: (summary) => ({ current: shipped(summary), target: 200 }),
  },
  {
    id: "hot-streak",
    title: "Hot Streak",
    description: "Merged 5 PRs in a single day.",
    icon: "🎯",
    color: "236 84 96",
    tier: "silver",
    section: "shipping",
    progress: counter("today", "prsMerged", 5),
  },
  {
    id: "seal-of-approval",
    title: "Seal of Approval",
    description: "Had 10 PRs approved.",
    icon: "✅",
    color: "96 196 128",
    tier: "bronze",
    section: "shipping",
    progress: counter("allTime", "prApproved", 10),
  },
  {
    id: "red-ink",
    title: "Red Ink",
    description: "Had changes requested on 10 PRs.",
    icon: "🖍️",
    color: "220 80 80",
    tier: "bronze",
    section: "shipping",
    secret: true,
    progress: counter("allTime", "prChangesRequested", 10),
  },
  {
    id: "works-on-my-machine",
    title: "Works on My Machine",
    description: "Had CI fail on 25 PRs.",
    icon: "🤷",
    color: "180 180 120",
    tier: "bronze",
    section: "shipping",
    secret: true,
    progress: counter("allTime", "prChecksFailed", 25),
  },
  {
    id: PLATINUM_ID,
    title: "Platinum",
    description: "Earned every other badge.",
    icon: "🏆",
    color: "190 214 232",
    tier: "platinum",
    section: "meta",
    progress: (summary) => ({
      current: BADGE_META_BASE_IDS.filter(
        (id) => summary.badges[id] !== undefined,
      ).length,
      target: BADGE_META_BASE_IDS.length,
    }),
  },
];

for (const badge of BADGE_META) {
  if (badge.id !== PLATINUM_ID) BADGE_META_BASE_IDS.push(badge.id);
}

/** Rack ordering: rarest tier last, so the easy wins read first. */
export const TIER_ORDER: Record<BadgeTier, number> = {
  bronze: 0,
  silver: 1,
  gold: 2,
  platinum: 3,
};

/** Human label for the tier chip on a medal. */
export const TIER_LABEL: Record<BadgeTier, string> = {
  bronze: "Bronze",
  silver: "Silver",
  gold: "Gold",
  platinum: "Platinum",
};

/** 0–1 completion for a locked badge, clamped. */
export function progressRatio(p: BadgeProgress): number {
  if (p.target <= 0) return 1;
  return Math.min(1, Math.max(0, p.current / p.target));
}

/** Where a track stands: earned against total, and whether it is complete. */
export interface TrackState {
  earned: number;
  total: number;
  /** Every badge in the track is earned; completing a track earns its title. */
  complete: boolean;
}

function isEarned(summary: StatsSummary, id: string): boolean {
  return summary.badges[id] !== undefined;
}

/**
 * Completion status for one track, derived from `summary.badges`. Complete
 * when every badge in the track is earned. The `meta` track holds only
 * platinum, so it completes once platinum is earned.
 */
export function trackState(
  section: BadgeSectionMeta,
  summary: StatsSummary,
): TrackState {
  const badges = BADGE_META.filter((b) => b.section === section.id);
  const earned = badges.filter((b) => isEarned(summary, b.id)).length;
  return { earned, total: badges.length, complete: earned === badges.length };
}

export interface EarnedTitle {
  section: BadgeSection;
  title: string;
  /** When the track was completed: the latest award among its badges. */
  at: string;
}

/** Titles for every complete track, earliest completion first. */
export function earnedTitles(summary: StatsSummary): EarnedTitle[] {
  const result: EarnedTitle[] = [];
  for (const section of BADGE_SECTIONS) {
    if (!trackState(section, summary).complete) continue;
    const times = BADGE_META.filter((b) => b.section === section.id).map(
      (b) => summary.badges[b.id],
    );
    const at = times.reduce((a, b) => (a > b ? a : b));
    result.push({ section: section.id, title: section.title, at });
  }
  return result.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

/**
 * Titles everyone holds from the start, so the header always has one to
 * show. The first is the default until you pick another or complete a track.
 * Kept distinct from every track title.
 */
export const STARTER_TITLES: readonly string[] = [
  "Greenhorn",
  "Tinkerer",
  "Wrangler",
  "Night Shift",
];

/** Earned and total badge counts per tier. */
export function tierTally(
  summary: StatsSummary,
): Record<BadgeTier, { got: number; of: number }> {
  const tally: Record<BadgeTier, { got: number; of: number }> = {
    bronze: { got: 0, of: 0 },
    silver: { got: 0, of: 0 },
    gold: { got: 0, of: 0 },
    platinum: { got: 0, of: 0 },
  };
  for (const badge of BADGE_META) {
    tally[badge.tier].of += 1;
    if (isEarned(summary, badge.id)) tally[badge.tier].got += 1;
  }
  return tally;
}
