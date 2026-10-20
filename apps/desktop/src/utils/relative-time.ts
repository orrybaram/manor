/**
 * How long ago something happened, in the two registers the app uses.
 *
 * There were three near-identical copies of this before it existed — one per
 * surface that needed it — differing only in whether they wrote "5m ago" or
 * "5 minutes ago", and in what they did with anything older than a week.
 */

/** "just now", "5m ago", "3h ago", "2d ago" — for dense rows and lists. */
export function relativeShort(ms: number): string {
  const { minutes, hours, days } = split(ms);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}

/**
 * `relativeShort` for the first week, then the calendar date — a row that says
 * "63d ago" has stopped being informative.
 */
export function relativeShortThenDate(ms: number): string {
  const { days } = split(ms);
  if (days < 7) return relativeShort(ms);
  return new Date(ms).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function split(ms: number): { minutes: number; hours: number; days: number } {
  const elapsed = Math.max(0, Date.now() - ms);
  return {
    minutes: Math.floor(elapsed / 60_000),
    hours: Math.floor(elapsed / 3_600_000),
    days: Math.floor(elapsed / 86_400_000),
  };
}

/** `relativeShort` of an ISO timestamp; empty when it doesn't parse. */
export function relativeShortIso(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? "" : relativeShort(ms);
}

/** Sort comparator: most recently updated first. */
export function byUpdatedDesc(a: { updatedAt: string }, b: { updatedAt: string }): number {
  return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
}
