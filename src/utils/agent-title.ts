const GENERIC_AGENT_TITLES = new Set([
  "claude",
  "claude code",
  "opencode",
  "codex",
  "pi",
]);

/**
 * `title` without the spinner frames and done markers agent CLIs animate in
 * their terminal title, so successive frames of one title compare equal.
 */
export function stripTitleMarkers(title: string): string {
  return title
    .replace(/[\u2800-\u28FF]/g, "") // braille spinner chars
    .replace(/[✳✻✽✶✢]/g, "") // done markers
    .trim();
}

export function cleanAgentTitle(
  title: string | null | undefined,
): string | null {
  if (!title) return null;
  const cleaned = stripTitleMarkers(title);
  if (!cleaned) return null;
  if (GENERIC_AGENT_TITLES.has(cleaned.toLowerCase())) return null;
  return cleaned;
}
