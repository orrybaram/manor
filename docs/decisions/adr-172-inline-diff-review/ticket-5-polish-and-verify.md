---
title: Keyboard affordances, docs, and full verification
status: done
priority: medium
assignee: sonnet
blocked_by: [1, 2, 3, 4]
---

# Keyboard affordances, docs, and full verification

## 1. Keyboard

- **⌘↩ / Ctrl+↩ inside the diff pane with a live selection** starts a comment
  on it — same path as clicking the chip. Register it in the existing
  `useMountEffect` keydown handler in `DiffPane.tsx`, next to the ⌘F handler,
  and guard it the same way (only when focus is inside `containerRef` or on
  `document.body`).
- The composer's own ⌘↩ (save) and Escape (cancel) must win over this — they
  already `stopPropagation` per ticket 2; confirm that holds.
- Escape with no composer open and drafts present does **not** discard the
  review. Losing a review to a stray Escape is unacceptable.

## 1b. Fix: a selection spanning two files anchors to the wrong file

Found while implementing ticket 3, and left open deliberately. `rowsInSelection`
in `review-anchor.ts` walks up from `range.commonAncestorContainer` to the
closest `[data-diff-lines]`, and when that misses it falls back to
`ancestor.querySelector("[data-diff-lines]")` — **the first one in document
order**, which for a selection spanning two files is the file `Stack`, so the
fallback can pick a file the selection does not start in. The chip then either
fails to appear or anchors the comment to the wrong file.

Fix in `review-anchor.ts`: resolve the container from `sel.anchorNode` first
(`anchorNode.parentElement?.closest("[data-diff-lines]")`, or `anchorNode`
itself when it is an element), and only fall back to the current
`commonAncestorContainer` walk when that yields nothing. Rows are then
collected from that one container only, which naturally clamps a cross-file
selection to the file it started in — the right behaviour, since a comment
anchors to one file by definition.

Extend `__tests__/review-anchor.test.ts` with a two-file DOM and a selection
that starts in the first file and ends in the second: assert the anchor's
indices and snippet cover only the first file's rows.

## 2. Empty and edge states

- Submitting with every draft body empty should be impossible: the review count
  and the submit button ignore drafts whose `body.trim()` is empty, and an
  empty draft that loses focus without being saved is removed.
- Switching `diffMode` (local ↔ branch) keeps the drafts — they are keyed by
  workspace, not mode — but line indices will not match the other mode's diff,
  so anchored cards may not render. That is the accepted drift; just confirm it
  does not throw.

## 3. Docs

- Add a `## Reviewing a diff` subsection to whichever part of `README.md`
  covers the diff pane (grep for "diff" first; if there is no such section,
  skip rather than invent one).
- `CHANGELOG.md`: add an `### Added` entry under the unreleased heading, in the
  style of the surrounding entries — "Comment on diff lines inline, batch the
  notes into a review, and send the whole review to a running agent or a new
  one."

## 4. Verification

Run and report output for:

```
pnpm typecheck   (or whatever package.json defines)
pnpm lint
pnpm test
pnpm build
```

Then a manual smoke pass, described in the final report:

1. Select lines in a diff → chip appears → click → composer appears anchored
   under the last selected line.
2. Type, ⌘↩ → card collapses to read view, the lines show the accent.
3. Add two more comments in different files → the review bar reads "3 comments".
4. Scroll the file hard, both directions — no row-height jitter, no cards
   detaching from their lines.
5. Submit with a running agent in the workspace → that pane is focused, the
   turn is interrupted, the prompt arrives as one line.
6. Submit with no running agent → a new agent tab opens with the prompt.

## Files to touch
- `src/components/workspace-panes/DiffPane/DiffPane.tsx` — ⌘↩ to comment on selection
- `README.md` — diff review docs (only if a diff section already exists)
- `CHANGELOG.md` — unreleased "Added" entry
