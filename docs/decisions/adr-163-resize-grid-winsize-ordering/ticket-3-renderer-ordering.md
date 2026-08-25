---
title: The renderer moves the grid after the winsize, never before
status: done
priority: critical
assignee: opus
blocked_by: [2]
---

# The renderer moves the grid after the winsize, never before

One component owns the size change. The grid's column count never drops below
the pty's, and a whole drag is one size change rather than one per frame.

- `useTerminalResize` drives everything off `proposeDimensions()` instead of
  calling `fit()`. On each observation it tracks the container in the directions
  that cannot hurt (grow columns, any row change) and restarts a 150ms settle.
  On settle it resizes the pty, waits for the ioctl, gives the program a bounded
  moment to redraw, then shrinks the grid — re-measuring first, so a pane that
  moved again is left to the settle already pending.
- Delete `term.onResize → resize()` and its debounce from
  `useTerminalLifecycle`. Two owners of one number is the bug; the debounce
  itself was right and belongs with the owner.
- Coalesce handoffs rather than queueing them — a drag outruns them, and
  `handOff` re-measures.
- `useTerminalStream` records when output last arrived and exposes
  `awaitSettled(quietMs, graceMs)`.
- `useTerminalConnection.resize` returns its promise rather than dropping it.

## Files to touch
- `src/hooks/useTerminalResize.ts` — the ordering, and the coalescing.
- `src/hooks/useTerminalStream.ts` — applied-position tracking, `awaitApplied`.
- `src/hooks/useTerminalLifecycle.ts` — hand the pieces over, drop the debounce.
- `src/hooks/useTerminalConnection.ts` — return the resize promise.
