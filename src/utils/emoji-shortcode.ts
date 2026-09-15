// Framework-free `:shortcode` emoji matching (ADR-174).
//
// This module owns everything that can be unit-tested without a DOM:
// finding an open `:query` at the caret, loading and searching the emoji
// index, and completing a `:shortcode:` typed in full. The React-facing
// `useEmojiAutocomplete` hook (src/components/ui/EmojiAutocomplete) is the
// only consumer and owns all DOM/React concerns.

/** One emoji entry, keyed by its GitHub/Slack-style shortcodes. */
export type EmojiEntry = {
  emoji: string;
  shortcodes: string[];
  label: string;
  tags: string[];
};

// Minimal local shapes for the two emojibase-data JSON files we import.
// `emojibase` itself isn't a dependency, so these are hand-rolled rather
// than imported.
type CompactEmoji = {
  hexcode: string;
  label: string;
  order?: number;
  tags?: string[];
  unicode: string;
  // Skin-tone variants. Present on some entries; deliberately ignored —
  // we only ever read the top-level entry, never `skins`.
  skins?: CompactEmoji[];
};

// hexcode -> shortcode, or hexcode -> shortcodes when an emoji has more
// than one GitHub-familiar alias (e.g. "1F44D" -> ["+1", "thumbsup"]).
type GithubShortcodes = Record<string, string | string[]>;

const QUERY_CHAR = /[a-z0-9_+-]/i;

/**
 * Find an open `:query` ending exactly at `caret`, e.g. `:sm` at the start
 * of the string, or after whitespace. Returns `null` for anything that
 * isn't a real trigger: no leading `:`, the `:` mid-word (`10:30`), the
 * caret sitting inside the query rather than at its end, or a query
 * shorter than 2 characters.
 */
export function findShortcodeQuery(
  value: string,
  caret: number,
): { start: number; end: number; query: string } | null {
  if (caret < 0 || caret > value.length) return null;
  // The caret must sit at the end of the query run, not in the middle of it.
  if (caret < value.length && QUERY_CHAR.test(value[caret])) return null;

  let queryStart = caret;
  while (queryStart > 0 && QUERY_CHAR.test(value[queryStart - 1])) {
    queryStart--;
  }
  if (queryStart === 0) return null; // no room for a leading ':'

  const colonIndex = queryStart - 1;
  if (value[colonIndex] !== ":") return null;

  // The character before the ':' must be start-of-string or whitespace.
  if (colonIndex > 0 && !/\s/.test(value[colonIndex - 1])) return null;

  const query = value.slice(queryStart, caret).toLowerCase();
  if (query.length < 2) return null;

  return { start: colonIndex, end: caret, query };
}

let indexPromise: Promise<EmojiEntry[]> | null = null;

/**
 * Load and join the emoji data + GitHub shortcode files, memoized so the
 * dynamic import only happens once. Skin-tone variants (`skins`) and
 * entries with no GitHub shortcode are skipped. Order follows emojibase's
 * own `compact.json` order.
 */
export function loadEmojiIndex(): Promise<EmojiEntry[]> {
  if (!indexPromise) {
    indexPromise = Promise.all([
      import("emojibase-data/en/compact.json"),
      import("emojibase-data/en/shortcodes/github.json"),
    ]).then(([compactModule, shortcodesModule]) => {
      const compact = compactModule.default as unknown as CompactEmoji[];
      const shortcodesByHex = shortcodesModule.default as unknown as GithubShortcodes;

      const entries: EmojiEntry[] = [];
      for (const item of compact) {
        const raw = shortcodesByHex[item.hexcode];
        if (raw == null) continue;
        const shortcodes = Array.isArray(raw) ? raw : [raw];
        if (shortcodes.length === 0) continue;

        entries.push({
          emoji: item.unicode,
          shortcodes,
          label: item.label,
          tags: item.tags ?? [],
        });
      }
      return entries;
    });
  }
  return indexPromise;
}

function rank(entry: EmojiEntry, query: string): number | null {
  if (entry.shortcodes.some((code) => code === query)) return 0;
  if (entry.shortcodes.some((code) => code.startsWith(query))) return 1;
  if (
    entry.shortcodes.some((code) => code.includes(query)) ||
    entry.label.toLowerCase().includes(query) ||
    entry.tags.some((tag) => tag.toLowerCase().includes(query))
  ) {
    return 2;
  }
  return null;
}

/**
 * Rank matches for `query`: exact shortcode match, then shortcode prefix,
 * then a substring match in shortcode/label/tag. Ties keep the index's
 * original (emojibase) order.
 */
export function searchEmoji(
  index: EmojiEntry[],
  query: string,
  limit = 8,
): EmojiEntry[] {
  const q = query.toLowerCase();
  const ranked: { entry: EmojiEntry; rank: number; position: number }[] = [];

  index.forEach((entry, position) => {
    const entryRank = rank(entry, q);
    if (entryRank !== null) ranked.push({ entry, rank: entryRank, position });
  });

  ranked.sort((a, b) => a.rank - b.rank || a.position - b.position);

  return ranked.slice(0, limit).map((r) => r.entry);
}

/**
 * When the user has just typed the closing `:` of an exact shortcode
 * (`:tada:`), replace it with the emoji in place — typing-through
 * completion, as in Slack. Returns `null` when the just-typed character
 * isn't a `:`, when there's no valid open query before it, or when the
 * query doesn't exactly match a shortcode.
 */
export function completeClosedShortcode(
  value: string,
  caret: number,
  index: EmojiEntry[],
): { value: string; caret: number } | null {
  if (caret < 1 || caret > value.length) return null;
  if (value[caret - 1] !== ":") return null;

  const match = findShortcodeQuery(value, caret - 1);
  if (!match) return null;

  const entry = index.find((e) => e.shortcodes.includes(match.query));
  if (!entry) return null;

  return replaceRange(value, match.start, caret, entry.emoji);
}

/** Replace `value[start:end]` with `text`, placing the caret right after it. */
export function replaceRange(
  value: string,
  start: number,
  end: number,
  text: string,
): { value: string; caret: number } {
  const nextValue = value.slice(0, start) + text + value.slice(end);
  return { value: nextValue, caret: start + text.length };
}
