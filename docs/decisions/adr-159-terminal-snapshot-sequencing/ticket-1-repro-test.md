---
title: Failing test — warm restore duplicates output across the attach gap
status: todo
priority: critical
assignee: sonnet
blocked_by: []
---

# Failing test — warm restore duplicates output across the attach gap

Pin the bug down at the daemon level before changing any protocol, so the rest
of the ADR has something that proves it worked.

The test drives a real `TerminalHost` session and reproduces what a warm restore
does: snapshot, then subscribe, with PTY output emitted in between and again
after. It then applies snapshot-plus-stream to a fresh headless xterm exactly
the way the renderer does, and compares the result with the daemon's own screen.

Today the two differ — output emitted between the snapshot and the subscribe is
missing, and output emitted after the snapshot but delivered on the stream is
applied on top of a screen that already contains it. Assert the *correct*
behavior so this test fails now and passes at the end of the ADR.

Mark it with a comment naming ADR-159 so the next person knows why it exists.

## Files to touch
- `electron/terminal-host/e2e.test.ts` — add the test here; the file already has
  an `E2EDaemon` harness with real sessions, mocked PTY subprocesses, and helpers
  for driving control/stream sockets. Reuse them rather than building a new rig.
- Drive PTY output through the existing mocked `fork` + `encodeFrame(MSG.DATA)`
  path the file already uses, so output timing is fully controlled.

## Notes
- Compare screens by serializing both terminals (`@xterm/addon-serialize`) —
  comparing raw byte streams will not work, since the point is that the same
  screen can be reached by different byte sequences.
- Keep the assertion about the *screen*, not about internal counters.
