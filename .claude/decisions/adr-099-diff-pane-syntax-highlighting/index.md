---
type: adr
status: accepted
database:
  schema:
    status:
      type: select
      options: [todo, in-progress, review, done]
      default: todo
    priority:
      type: select
      options: [critical, high, medium, low]
    assignee:
      type: select
      options: [opus, sonnet, haiku]
  defaultView: board
  groupBy: status
---

# ADR-099: Add syntax highlighting to DiffPane

## Context

The DiffPane component renders git diffs as plain monochrome text (with only red/green diff coloring). This makes it harder to read code changes — users can't quickly distinguish keywords, strings, comments, etc. within the diff lines.

The app needs to support any programming language since users work in diverse codebases. Bundle size is a key constraint.

## Decision

Use **refractor** (Prism-based, ~16KB gzipped) for syntax highlighting in the DiffPane. Refractor supports 290+ languages via selective loading from `refractor/lib/core`, returns HAST (virtual AST) nodes that map cleanly to React, and uses well-documented Prism token classes.

### Approach

1. **Install refractor** as a dependency.
2. **Create a utility module** (`src/components/workspace-panes/DiffPane/syntax.ts`) that:
   - Maps file extensions to refractor language grammars
   - Lazily registers languages on first use (dynamic `import()`)
   - Exposes a `tokenize(code: string, lang: string)` function returning HAST nodes
3. **Create a `useHighlightedLines` hook** that takes parsed `DiffLine[]` and a file path, resolves the language, and returns highlighted React nodes per line. Uses `useMemo` so re-highlighting only happens when diff content or file path changes.
4. **Modify `DiffLines` component** to use highlighted fragments instead of plain text, while preserving the existing search highlight overlay (search marks are applied on top of syntax tokens).
5. **Add Prism token CSS** to `DiffPane.module.css` using the existing CSS variable system (`--text-dim`, `--blue`, `--green`, `--yellow`, `--red`, etc.) for theme consistency.
6. **Context lines keep syntax colors; add/del lines blend** syntax token colors with the diff background tints using `color-mix()` so the diff semantic meaning (added/removed) remains visually dominant.

### Language loading strategy

- Pre-register a small set of common languages synchronously (js, ts, tsx, jsx, css, html, json, python, go, rust, bash, yaml, markdown).
- For other languages, fall back to plain text — no runtime fetching or code-splitting complexity.

## Consequences

- **Better**: Code diffs become much more readable with keyword/string/comment coloring.
- **Tradeoff**: ~16KB added to bundle (acceptable for the functionality gained).
- **Risk**: Prism's tokenizer is line-oriented which works well for diffs, but some edge cases (multi-line strings split across hunks) may highlight imperfectly — acceptable for a diff viewer.
- **Simpler alternative rejected**: sugar-high (~3KB) was considered but uses a single generic tokenizer that can't properly handle the full range of languages users may encounter.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
