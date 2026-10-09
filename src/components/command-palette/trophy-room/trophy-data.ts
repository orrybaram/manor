import type { StatsSummary } from "../../../electron.d";
import {
  BADGE_META,
  BADGE_SECTIONS,
  earnedTitles,
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
 * Earned first, oldest unlock first so the list reads as a history; then
 * locked, closest first, so whatever you are about to unlock leads the run.
 */
function byRackOrder(a: BadgeEntry, b: BadgeEntry): number {
  if (a.awardedAt && b.awardedAt) return a.awardedAt.localeCompare(b.awardedAt);
  if (a.awardedAt) return -1;
  if (b.awardedAt) return 1;
  return b.ratio - a.ratio;
}

/** A track's badges in rack order. */
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
 * The title the header shows: the chosen one while it is still earned,
 * otherwise the most recently completed. `null` when no track is complete.
 */
export function displayedTitle(
  summary: StatsSummary,
  chosen: string | null,
): EarnedTitle | null {
  const titles = earnedTitles(summary);
  return (
    titles.find((t) => t.title === chosen) ?? titles[titles.length - 1] ?? null
  );
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
