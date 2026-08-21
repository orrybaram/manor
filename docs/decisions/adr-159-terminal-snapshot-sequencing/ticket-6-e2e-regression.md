---
title: End-to-end regression — a resize on attach must not duplicate a frame
status: todo
priority: high
assignee: sonnet
blocked_by: [5]
---

# End-to-end regression — a resize on attach must not duplicate a frame

Cover the user-visible bug in the real app: a TUI that repaints on SIGWINCH,
restored into a pane whose measured size differs from the session's.

Shape of the test:

1. Boot a workspace with a terminal, wait for the shell prompt.
2. Run a stand-in TUI: prints a marker line, and reprints it on SIGWINCH.
3. Force the terminal's next measurement to differ — resizing the Electron
   window between the reload trigger and the pane remounting is the most direct
   way; splitting the pane is an alternative if that proves flaky.
4. Reload the renderer so the pane remounts and warm-restores.
5. Assert the marker appears on screen the same number of times as before the
   reload.

## Files to touch
- `tests/e2e/output-duplication.spec.ts` — add the test alongside the existing
  ones; reuse `awaitShellReady`, `runOnce`, `scrollback` and `onScreenMatches`
  from that file.

## Notes
- Count relative to a pre-reload baseline, not an absolute number: a legitimate
  resize before the reload may itself repaint once, and that is not the bug.
- The existing controls in that file prove the search-count oracle and the
  SIGWINCH tripwire actually register — keep them passing.
- Verify the whole suite (`pnpm test`, `pnpm test:e2e`) on a quiet machine; this
  suite is timing-sensitive under parallel Electron launches.
