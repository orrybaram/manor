---
title: Pin the repair invariant
status: done
priority: high
assignee: sonnet
blocked_by: [1, 2, 3]
---

# Pin the repair invariant

The claim to defend is not "resizes are ordered" — ADR-164 already owns that,
and it measures clean. It is: **a client whose grid has drifted is put right at
the next settle, whatever caused the drift.** Test that as a property, not as
the sum of its three parts.

## What to cover

`electron/terminal-host/session.test.ts` (extend):

1. **A no-op resize still broadcasts.** Resize a session to the size it already
   has; assert a `resized` event reached the attached socket carrying that size,
   and that no `MSG.RESIZE` frame was written to the subprocess — the program
   must not be made to repaint for a request that changed nothing.
2. **An ack publishes the size it belongs to.** Drive two resizes without
   feeding a `MSG.RESIZED` between them, then feed the first ack; assert the
   `resized` event carries the *first* pair, not the second.
3. **`data` cannot overtake `resized`.** Feed a `MSG.DATA` frame, then
   `MSG.RESIZED`, then another `MSG.DATA`, all synchronously; assert the events
   the socket received are in that order. This fails against the old
   write-callback broadcast without needing to simulate a backlog.

`electron/terminal-host/terminal-host.test.ts` (extend):

4. **`create` on an existing session reconciles its size** — call `create` twice
   with different `cols`/`rows` and assert the returned `info` reports the
   second pair.

`src/hooks/__tests__/` (new, or wherever hook tests live — check first; if there
is no harness for hooks, put this one as a plain unit test over the decision
rather than the hook):

5. **A drifted grid does not suppress the send.** With the last-sent pair at
   `(100, 30)` and the grid at `(80, 24)`, a measurement of `(100, 30)` must not
   send, and a measurement of `(120, 40)` must. The point is that the grid's
   value is not consulted either way.

## Files to touch

- `electron/terminal-host/session.test.ts`
- `electron/terminal-host/terminal-host.test.ts`
- `src/hooks/useTerminalResize.ts` — only if (5) needs the skip decision lifted
  into an exported pure helper to be testable. Prefer that over mounting React:
  a named function that takes `(proposed, lastSent)` and returns whether to send
  is the whole of the rule, and it documents itself.

## Verify

`pnpm test`
