---
title: Broadcast a resized stream event when the ioctl lands
status: done
priority: critical
assignee: opus
blocked_by: []
---

# Broadcast a `resized` stream event when the ioctl lands

The daemon knows exactly where in the output stream the winsize changed: the
subprocess flushes its batched output before the ioctl and writes `MSG.RESIZED`
after it, so that frame follows every pre-resize byte and precedes every
post-resize one. Publish that position to attached clients.

## Files to touch

- `electron/terminal-host/types.ts` — add
  `{ type: "resized"; sessionId: string; cols: number; rows: number }` to
  `StreamEvent`; bump `TERMINAL_HOST_PROTOCOL` to 3 with a line saying what 3
  means (clients learn where in the stream the size changed).
- `electron/terminal-host/session.ts` — in the `MSG.RESIZED` case, call
  `broadcastEvent({ type: "resized", sessionId, cols, rows })` with the
  session's current size, alongside the existing `resizeMirror()`. Broadcast on
  the ack-timeout path too, so a client is never left waiting on an event that
  will not come.
- `electron/terminal-host/client.ts` — the event flows through the existing
  `StreamEvent` handler; confirm no filtering drops an unknown type.

## Notes

Order matters: the event must be broadcast at the same point the mirror is
resized, not before the pending write queue drains.
