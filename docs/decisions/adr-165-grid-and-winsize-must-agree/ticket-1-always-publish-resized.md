---
title: Every resize request publishes a resized event
status: done
priority: critical
assignee: sonnet
blocked_by: []
---

# Every resize request publishes a resized event

`Session.resize` returns early when the requested size already matches the
session's, and says nothing to anyone. A client whose grid has drifted asks for
the size it should already have and is told nothing — so the drift is permanent.

Publish instead. Skip the ioctl when the size is unchanged (the program must not
be made to repaint for a no-op), but broadcast `resized` with the current size.
Clients that already agree ignore it: `resizeInStream` returns without touching
the terminal when the pair matches.

Also close the unreachable-but-same-shaped hole in `TerminalHost.create`: it
returns an existing session's `info` and ignores the `cols`/`rows` it was handed.
Nothing hits it today only because `client.doCreateOrAttach` sends an explicit
`resize` first. Make the reconciliation the host's job rather than one caller's.

## Files to touch

- `electron/terminal-host/session.ts` — in `resize()`, replace
  `if (this.cols === cols && this.rows === rows) return;` with a branch that
  calls `applyResized` for the current size and returns, so the event still goes
  out and the subprocess is not written to. Say in the comment why the event is
  worth sending when nothing changed: it is the only repair for a client whose
  grid drifted, and it is free for one that did not.
- `electron/terminal-host/terminal-host.ts` — on the existing-session path,
  `void session.resize(cols, rows)` before returning `session.info`. Keep
  `create` synchronous: `Session.resize` records the size and writes towards
  the subprocess before it awaits anything, so `info` already reports what the
  caller asked for. Awaiting would buy nothing and add an ioctl round trip to
  every reattach.

## Verify

`pnpm test`
