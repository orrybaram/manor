---
title: applyResized publishes at the marker, and at the acknowledged size
status: done
priority: high
assignee: sonnet
blocked_by: [1]
---

# applyResized publishes at the marker, and at the acknowledged size

Two defects in ADR-164's publishing half. Both were measured as quiet today — a
median 1.5ms window, zero data events overtaking it across ten resizes — and
both open exactly the disagreement ticket 1 then has to repair, so they are
worth closing at the source rather than relying on the repair.

**1 — the broadcast sits behind the mirror's parse backlog.** `applyResized`
emits `resized` from inside `this.headless.write("", cb)`, which runs when the
mirror's write queue drains. Every `data` event, by contrast, is broadcast
synchronously from the `MSG.DATA` case the instant a frame is decoded. So under
a backlog, post-resize output can reach a client ahead of the resize it comes
after.

The mirror's own `resize` must stay in the write callback — the subprocess
flushed its pre-ioctl output before the ioctl, so those bytes are already queued
and a bare `resize` would jump them. Only the broadcast moves out.

**2 — it publishes the newest size, not the acknowledged one.** `applyResized`
reads `this.cols`/`this.rows`, which are already the latest size asked for. With
two resizes in flight, the first `MSG.RESIZED` — which acknowledges the *first*
ioctl — publishes the second one's size. On a shrinking drag that hands clients
a grid narrower than the pty their program is reading from, which is the
direction that strands.

## Files to touch

- `electron/terminal-host/session.ts`
  - `pendingResizes` — add `cols`/`rows` to the entry type and push them in
    `resize()`. Replace the comment arguing for *not* carrying them: the marker
    belongs to one specific ioctl, so the size it reports is that ioctl's.
  - `applyResized(cols, rows)` — take the pair as arguments. Keep
    `headless.write("", () => headless.resize(cols, rows))`; move
    `broadcastEvent({ type: "resized", ... })` out of the callback to run
    synchronously. Comment why the two halves are ordered differently: the
    mirror's position is in its own write queue, a client's is among the events
    this object broadcasts.
  - Update every call site — the `MSG.RESIZED` case (the shifted entry's pair),
    the no-subprocess early return, the ack timeout (that entry's pair), and the
    unchanged-size path added by ticket 1 (the session's current pair).

## Verify

`pnpm test` — `electron/terminal-host/session.test.ts` must stay green.
