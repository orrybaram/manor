---
title: Extract PrDetails from PrPopover
status: todo
priority: high
assignee: sonnet
blocked_by: []
---

# Extract PrDetails from PrPopover

Split the body of the PR hover card in `src/components/sidebar/PrPopover.tsx`
into an exported `PrDetails` component so the phone can show the same content
in a drawer (ADR-223 D1).

- `PrDetails` props: `{ pr: PrInfo; workspacePath?: string; hostId?: string }`.
- It renders everything currently inside `Popover.Content` *except* the
  Radix wrapper and its event handlers: the header row (icon, `#number`,
  state, draft, diff stat), `SummaryRows`, checks, reviewers and comments
  sections — whatever is there today, in the same order.
- `PrPopover` renders `<PrDetails …/>` inside its existing `Popover.Content`.
  The desk popover must look and behave exactly as before (hover, keyboard
  focus handling, stopPropagation handlers stay on `Popover.Content`).
- Keep `PrDetails` in `PrPopover.tsx` (it uses the file's private helpers and
  `PrPopover.module.css`); just export it.
- If any existing tests render `PrPopover`, they must still pass.

## Files to touch
- `src/components/sidebar/PrPopover.tsx` — extract and export `PrDetails`
