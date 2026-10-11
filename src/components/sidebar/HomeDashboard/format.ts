/**
 * Short duration labels for the Home dashboard (ADR-198): card ages, the
 * longest wait, the oldest open PR. One unit only — "40s", "12m", "3h", "2d" —
 * so they fit in a card header next to the project chip.
 */
export function formatAge(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** "14:05" in the user's locale — the "since HH:MM" of a young activity recorder. */
export function formatClock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** "Tuesday, 29 September" — the header's date eyebrow. */
export function formatDateEyebrow(at: number): string {
  return new Date(at).toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}
