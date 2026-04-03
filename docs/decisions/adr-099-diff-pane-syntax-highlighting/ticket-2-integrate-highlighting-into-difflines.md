---
title: Integrate syntax highlighting into DiffLines component
status: done
priority: high
assignee: opus
blocked_by: [1]
---

# Integrate syntax highlighting into DiffLines component

## Tasks

1. In `DiffPane.tsx`, use `refractor.highlight()` + `toH()` (from `hast-to-hyperscript`) or manual HAST-to-React conversion to render syntax-highlighted code in each diff line.
2. The highlighting must compose with the existing search highlighting:
   - First, syntax-highlight the line content into tokens
   - Then, apply search match `<mark>` overlays on top of the rendered tokens
   - This means the `highlightText` function needs to work on the rendered HTML/React nodes rather than raw strings, OR we render syntax tokens and overlay search marks via CSS/DOM position
   - **Simplest approach**: render syntax tokens as `<span>` elements with Prism classes, then use the existing `highlightText` function on each token's text content (splitting tokens at match boundaries)
3. Pass the file path (for language detection) into `DiffLines` component
4. Use `useMemo` to avoid re-highlighting on every render

## Files to touch
- `src/components/workspace-panes/DiffPane/DiffPane.tsx` — modify `DiffLines` component, update `highlightText` to work with syntax tokens, pass file path through
