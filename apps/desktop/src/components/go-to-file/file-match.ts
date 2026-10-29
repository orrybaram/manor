/**
 * Ranking a workspace's file paths against what was typed in Go to File:
 * the typed characters, spaces ignored, must appear in order in the path.
 * A match inside the file name beats one spread over its folders; runs of
 * consecutive characters and characters at word starts (after `/`, `.`, `_`,
 * `-`, or a lower-to-upper case change) score higher; a shorter path breaks
 * a tie.
 */

export interface FileMatch {
  path: string;
  /** Indexes into `path` of the matched characters, for highlighting. */
  positions: number[];
}

/** Characters after which a word starts. */
const SEPARATORS = new Set(["/", "\\", ".", "_", "-", " "]);

/** A match wholly in the file name outranks any that reaches into folders. */
const NAME_BONUS = 1000;

function isWordStart(text: string, i: number): boolean {
  if (i === 0) return true;
  const prev = text[i - 1];
  if (SEPARATORS.has(prev)) return true;
  const ch = text[i];
  return prev === prev.toLowerCase() && ch !== ch.toLowerCase();
}

/**
 * Match `query` (lower case, no spaces) in `text` from `from` on, leftmost
 * first; null when it isn't a subsequence.
 */
function matchFrom(
  text: string,
  lower: string,
  query: string,
  from: number,
): { score: number; positions: number[] } | null {
  const positions: number[] = [];
  let score = 0;
  let at = from;
  for (const ch of query) {
    const i = lower.indexOf(ch, at);
    if (i < 0) return null;
    const prev = positions[positions.length - 1];
    if (prev !== undefined && i === prev + 1) score += 5;
    if (isWordStart(text, i)) score += 3;
    positions.push(i);
    at = i + 1;
  }
  return { score, positions };
}

/** The match's score and positions, or null when `path` doesn't match. */
export function scorePath(
  path: string,
  query: string,
): { score: number; positions: number[] } | null {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return { score: 0, positions: [] };
  const lower = path.toLowerCase();
  const nameStart = path.lastIndexOf("/") + 1;
  const inName = matchFrom(path, lower, q, nameStart);
  if (inName) {
    // An exact or prefix name match goes first.
    const prefix = lower.startsWith(q, nameStart) ? 10 : 0;
    return {
      score: NAME_BONUS + inName.score + prefix - path.length / 100,
      positions: inName.positions,
    };
  }
  const anywhere = matchFrom(path, lower, q, 0);
  if (!anywhere) return null;
  return {
    score: anywhere.score - path.length / 100,
    positions: anywhere.positions,
  };
}

/**
 * The best `limit` matches of `query` among `paths`, best first. An empty
 * query lists the first `limit` paths as given.
 */
export function rankFiles(
  paths: readonly string[],
  query: string,
  limit: number,
): FileMatch[] {
  if (!query.trim()) {
    return paths.slice(0, limit).map((path) => ({ path, positions: [] }));
  }
  const scored: { path: string; score: number; positions: number[] }[] = [];
  for (const path of paths) {
    const match = scorePath(path, query);
    if (match) scored.push({ path, ...match });
  }
  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return scored
    .slice(0, limit)
    .map(({ path, positions }) => ({ path, positions }));
}
