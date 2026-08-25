---
title: An e2e test that reproduces the duplication
status: done
priority: critical
assignee: opus
blocked_by: []
---

# An e2e test that reproduces the duplication

Nothing printed once duplicates, so the repro needs a program that repaints a
frame in place. `tests/e2e/helpers/fake-tui.sh` is that program: it draws
`ZQFRAME` lines the width of the terminal, moves the cursor back up over them
and draws them again, and re-measures on SIGWINCH the way a real harness does —
so any duplication is the emulator and the pty disagreeing, not the script
lagging.

It also has to **stream continuously**, which the first version did not. A fake
that idles between frames makes "the next chunk after the resize" look like the
program's redraw, which is the assumption that shipped and was wrong. Drive both
drag regimes: fast enough that the whole sweep settles once, and slow enough
that it settles on every step.

The test drives the window edge from the main process (`BrowserWindow.setSize`
in a loop, held long enough for the app to react) and counts `ZQFRAME` through
the search-addon oracle the file already uses. Add the control that proves the
drag reaches the pty, so the assertion cannot pass for free.

## Files to touch
- `tests/e2e/helpers/fake-tui.sh` — new; the repainting stand-in agent.
- `tests/e2e/output-duplication.spec.ts` — the resize case belongs in the file
  that already owns "printed once, on screen twice", plus the SIGWINCH control.
