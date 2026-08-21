---
title: Daemon — sequence-number the output stream and stamp snapshots
status: todo
priority: critical
assignee: sonnet
blocked_by: [1]
---

# Daemon — sequence-number the output stream and stamp snapshots

Give each session a monotonic counter over the `data` events it broadcasts, and
record the counter's value in every snapshot. This is the fact the renderer
needs to tell "output I already have" from "output I still need".

## Files to touch
- `electron/terminal-host/types.ts` — add `seq: number` to the `data` variant of
  `StreamEvent`, and `seq: number` to `TerminalSnapshot`.
- `electron/terminal-host/session.ts` — add a private `outputSeq` counter,
  starting at 0. Increment it for every broadcast `data` event and include the
  value on the event. `getSnapshot()` returns the counter's current value after
  `flushHeadless()`, so the number describes exactly what the serialized screen
  contains.
- `electron/terminal-host/session.test.ts` — cover: seq increases by one per data
  event; a snapshot taken after N events reports N; a snapshot taken again with
  no intervening output reports the same number.

## Notes
- Count events, not bytes. The renderer drops whole queued chunks.
- `flushHeadless()` must happen before reading the counter, otherwise the
  snapshot can claim bytes its screen has not applied yet.
