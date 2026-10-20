import { shellTitlePath } from "../src/utils/agent-title";

const GENERIC_AGENT_TITLES = new Set([
  "claude",
  "claude code",
  "opencode",
  "codex",
  "pi",
]);

/**
 * The Agent name a terminal title gives, or null when it gives none: empty
 * once spinner frames and done markers are gone, an agent CLI's generic
 * title, or the shell's own prompt title.
 */
export function cleanAgentTitle(
  title: string | null | undefined,
): string | null {
  if (!title) return null;
  const cleaned = title
    .replace(/[\u2800-\u28FF]/g, "") // braille spinner chars
    .replace(/[✳✻✽✶✢]/g, "") // done markers
    .trim();
  if (!cleaned) return null;
  if (GENERIC_AGENT_TITLES.has(cleaned.toLowerCase())) return null;
  // A shell's own prompt title ("user@host:~/code") names a directory, not
  // the agent: it is what the pane shows before the agent sets a title and
  // again the moment the agent exits.
  if (shellTitlePath(cleaned) !== null) return null;
  return cleaned;
}
