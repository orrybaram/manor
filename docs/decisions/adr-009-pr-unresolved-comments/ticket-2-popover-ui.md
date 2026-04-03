---
title: Show unresolved thread count in PR popover
status: todo
priority: high
assignee: sonnet
blocked_by: [1]
---

# Show unresolved thread count in PR popover

Add a row to the PR popover showing the number of unresolved review threads.

## Implementation

In `src/components/PrPopover.tsx`:

1. Import `MessageSquare` from `lucide-react`
2. After the `reviewElement` block, add a new `commentsElement` block:
   - Only render when `pr.unresolvedThreads != null && pr.unresolvedThreads > 0`
   - Use `MessageSquare` icon (size 12) with `var(--yellow, #eab308)` color
   - Text: `{count} unresolved` (e.g. "3 unresolved")
3. Render `{commentsElement}` after `{reviewElement}` in the JSX

## Files to touch
- `src/components/PrPopover.tsx` — Add unresolved comments row
