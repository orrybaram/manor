---
title: sendFit decides from the last size it sent, not from the grid
status: done
priority: critical
assignee: sonnet
blocked_by: []
---

# sendFit decides from the last size it sent, not from the grid

`sendFit` skips when `proposeDimensions()` matches `term.cols`/`term.rows`. That
tests the *grid* and uses it as a proxy for the pty. After ADR-164 the grid is
driven by the daemon, so the grid cannot also be the evidence for what the
daemon knows — and when the two have drifted, this early return is precisely
what stops the one send that would fix it.

Keep the coalescing; change what it is measured against. Track the last
`(cols, rows)` handed to `resizePty` and skip only when the new measurement
equals that. Combined with ticket 1 — where the daemon answers even a no-op
request with a `resized` event — a drifted grid is repaired at the next settle
without anything having to work out why it drifted.

Reset the remembered pair whenever the hook re-arms (the `fitAddon !==
prevFitAddonRef.current` block), alongside the timers and observer it already
clears there: a new terminal has sent nothing.

## Files to touch

- `src/hooks/useTerminalResize.ts` — add a `lastSentRef`; set it in `sendFit`
  before calling `resizePty`; compare against it instead of against
  `t.cols`/`t.rows`; clear it in the re-arm block. Update the file's header
  comment, which currently explains the hook as pure geometry — that is still
  true, and this is the sentence that makes it true: the hook may not read the
  grid to decide what the pty knows.

  Note the `term.onResize` refit loop below it still needs `term` — it fires
  when the grid moves and re-measures against the grid that now exists. That
  behaviour is unchanged; only the skip condition moves.

## Verify

`pnpm test`, and the drag path by hand: a window resize still settles to one pty
resize, and the pane still fits its box afterwards.
