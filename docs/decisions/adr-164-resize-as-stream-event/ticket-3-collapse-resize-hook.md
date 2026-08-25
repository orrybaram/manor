---
title: Collapse useTerminalResize to measure, debounce, send
status: done
priority: high
assignee: opus
blocked_by: [2]
---

# Collapse `useTerminalResize` to measure, debounce, send

With the grid driven from the stream, the hook stops owning the terminal's size
and everything that existed to manage the gap goes with it.

## Files to touch

- `src/hooks/useTerminalResize.ts` — reduce to: ResizeObserver → rAF →
  `proposeDimensions()` → debounce → `resizePty(cols, rows)`. No `term.resize`,
  no union, no invariant, no re-measure loop, no redraw wait. Keep the 0×0
  container guard and the `t.refresh(0, t.rows - 1)` WebGL workaround, moving
  the refresh to where the grid actually changes (the stream handler).
- `src/hooks/useTerminalStream.ts` — delete `awaitRedraw`, `lastOutputAtRef`,
  `outputCountRef` and the grace/quiet constants.
- `src/hooks/useTerminalLifecycle.ts` — drop the `awaitRedraw` argument.
- `src/lib/terminal-grid.ts` — delete; `growToward` has no callers left.

## Notes

The debounce stays, but its justification changes: it is there so a drag does
not cost the program a full re-render per animation frame, not to keep the two
sizes in agreement. Say so in the comment.
