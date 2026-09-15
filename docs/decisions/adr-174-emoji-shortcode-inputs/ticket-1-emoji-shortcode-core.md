---
title: Emoji data and shortcode matching core
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Emoji data and shortcode matching core

Add the emoji dataset and the framework-free matching logic described in
ADR-174 ("Data" and "Pure logic" sections).

1. `pnpm add emojibase-data`.
2. Create `src/utils/emoji-shortcode.ts` exporting:
   - `type EmojiEntry = { emoji: string; shortcodes: string[]; label: string; tags: string[] }`
   - `findShortcodeQuery(value: string, caret: number): { start: number; end: number; query: string } | null`.
     Scan back from `caret` over `[a-z0-9_+-]` (case-insensitive; lowercase
     the query). The char before the run must be `:`, and the char before that
     `:` must be start-of-string or whitespace. Require `query.length >= 2`.
     `start` is the index of the `:`, `end` is `caret`.
   - `loadEmojiIndex(): Promise<EmojiEntry[]>`. Memoize the promise at module
     scope. Use dynamic `import("emojibase-data/en/compact.json")` and
     `import("emojibase-data/en/shortcodes/github.json")` so Vite code-splits
     them. Join on `hexcode`. Skip entries with no shortcodes. Skip
     skin-tone variants (only use top-level compact entries and ignore
     `skins`). Keep emojibase `order`.
   - `searchEmoji(index: EmojiEntry[], query: string, limit = 8): EmojiEntry[]`.
     Rank: exact shortcode match, then shortcode prefix, then substring in
     shortcode/label/tag. Stable within a rank.
   - `completeClosedShortcode(value, caret, index): { value: string; caret: number } | null`.
     When `value[caret - 1] === ":"` and the text before it forms a valid
     query (same rules as `findShortcodeQuery`, applied with caret - 1) that
     exactly equals a shortcode, replace `:code:` with the emoji.
   - `replaceRange(value, start, end, text): { value: string; caret: number }`.
   Read the JSON types from `emojibase` or declare minimal local types. Check
   how `resolveJsonModule` is configured in `tsconfig` and adjust if the JSON
   import does not typecheck.
3. Create `src/utils/emoji-shortcode.test.ts` next to it, following the
   existing `src/utils/sidebar-items.test.ts` style. Cover:
   - Triggers: `:sm` at start, `hi :sm`.
   - Non-triggers: `10:30`, `http://x`, `:)`, `:s` (too short), caret not at
     the end of the token.
   - Ranking: exact before prefix before substring.
   - `completeClosedShortcode` for `hi :tada:`, and `null` for an unknown code.
   - `replaceRange` caret position with multi-codepoint emoji
     (`"👍🏽".length === 4`).
   Tests use a small hand-built index for ranking and one real
   `loadEmojiIndex()` call to confirm the data loads and `tada` resolves to 🎉.

Code nothing uses yet fails `pnpm knip:ci`. If knip flags these exports before
ticket 2 lands, that is expected. Do not add ignores; ticket 2 consumes them.

## Files to touch
- `package.json`, `pnpm-lock.yaml`: add `emojibase-data`
- `src/utils/emoji-shortcode.ts`: new
- `src/utils/emoji-shortcode.test.ts`: new
