const GENERIC_AGENT_TITLES = new Set(["claude", "claude code", "opencode", "codex"]);

export function cleanAgentTitle(title: string | null | undefined): string | null {
  if (!title) return null;
  const cleaned = title
    .replace(/[\u2800-\u28FF]/g, "")  // braille spinner chars
    .replace(/[✳✻✽✶✢]/g, "")          // done markers
    .trim();
  if (!cleaned) return null;
  if (GENERIC_AGENT_TITLES.has(cleaned.toLowerCase())) return null;
  return cleaned;
}
