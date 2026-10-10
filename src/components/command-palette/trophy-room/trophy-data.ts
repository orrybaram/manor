import type { StatsSummary } from "../../../electron.d";
import {
  BADGE_META,
  BADGE_SECTIONS,
  STARTER_TITLES,
  TIER_ORDER,
  progressRatio,
  trackState,
  type BadgeMeta,
  type BadgeSection,
  type BadgeSectionMeta,
  type EarnedTitle,
} from "../../../lib/badges";

/**
 * Display-side derivations for the trophy room (ADR-212), kept out of the
 * component files so they fast-refresh and can be unit tested.
 */

/** What the Badges tab shows on the right: the Summary pane or one track. */
export type TrackSelection = BadgeSection | "summary";

export interface BadgeEntry {
  badge: BadgeMeta;
  /** ISO award timestamp, or `null` while the badge is still locked. */
  awardedAt: string | null;
  /** Clamped to `target`. */
  current: number;
  target: number;
  /** 0–1 completion; always 1 for an earned badge. */
  ratio: number;
}

function entryFor(badge: BadgeMeta, summary: StatsSummary): BadgeEntry {
  const awardedAt = summary.badges[badge.id] ?? null;
  const progress = badge.progress(summary);
  return {
    badge,
    awardedAt,
    current: Math.min(progress.current, progress.target),
    target: progress.target,
    ratio: awardedAt ? 1 : progressRatio(progress),
  };
}

/**
 * By tier, bronze up to platinum, then by target within a tier, so a track
 * reads as a ladder and a badge keeps its place whether earned or not.
 */
function byRackOrder(a: BadgeEntry, b: BadgeEntry): number {
  return (
    TIER_ORDER[a.badge.tier] - TIER_ORDER[b.badge.tier] || a.target - b.target
  );
}

/** A track's badges in rack order: by tier, then by target. */
export function trackEntries(
  section: BadgeSectionMeta,
  summary: StatsSummary,
): BadgeEntry[] {
  return BADGE_META.filter((b) => b.section === section.id)
    .map((b) => entryFor(b, summary))
    .sort(byRackOrder);
}

/** A secret stays `???` until it is earned or you choose to reveal it. */
export function isHiddenSecret(
  entry: BadgeEntry,
  revealed: ReadonlySet<string>,
): boolean {
  return (
    entry.badge.secret === true &&
    entry.awardedAt === null &&
    !revealed.has(entry.badge.id)
  );
}

/**
 * A track whose every badge is a secret you have neither earned nor revealed
 * (Lord of the Manor) hides its name and title too.
 */
export function isHiddenTrack(
  section: BadgeSectionMeta,
  summary: StatsSummary,
  revealed: ReadonlySet<string>,
): boolean {
  return trackEntries(section, summary).every((e) =>
    isHiddenSecret(e, revealed),
  );
}

/**
 * The title the header shows: the chosen one while it is still earned or is
 * a starter title, otherwise the most recently completed track's, otherwise
 * the first starter title.
 */
export function displayedTitle(
  earned: readonly EarnedTitle[],
  chosen: string | null,
): string {
  if (chosen !== null) {
    if (earned.some((t) => t.title === chosen)) return chosen;
    if (STARTER_TITLES.includes(chosen)) return chosen;
  }
  return earned[earned.length - 1]?.title ?? STARTER_TITLES[0];
}

/**
 * "Next up" on the Summary pane: the closest locked badge in each incomplete
 * track, then the closest `limit` of those. Secret badges never appear.
 */
export function nextUp(summary: StatsSummary, limit = 3): BadgeEntry[] {
  const picks: BadgeEntry[] = [];
  for (const section of BADGE_SECTIONS) {
    if (trackState(section, summary).complete) continue;
    const closest = trackEntries(section, summary).find(
      (e) => e.awardedAt === null && !e.badge.secret,
    );
    if (closest) picks.push(closest);
  }
  return picks.sort((a, b) => b.ratio - a.ratio).slice(0, limit);
}

/** The last `limit` badges earned, newest first. */
export function recentUnlocks(summary: StatsSummary, limit = 5): BadgeEntry[] {
  return BADGE_META.filter((b) => summary.badges[b.id] !== undefined)
    .map((b) => entryFor(b, summary))
    .sort((a, b) => (b.awardedAt ?? "").localeCompare(a.awardedAt ?? ""))
    .slice(0, limit);
}

export function formatAwarded(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
