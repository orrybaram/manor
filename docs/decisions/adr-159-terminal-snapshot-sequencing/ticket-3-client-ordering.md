---
title: Client — subscribe before snapshotting, and return the snapshot's seq
status: done
priority: critical
assignee: opus
blocked_by: [2]
---

# Client — subscribe before snapshotting, and return the snapshot's seq

Reorder the warm-restore handshake so no output can fall between the round
trips, and hand the snapshot's sequence number up to the caller.

New order in `doCreateOrAttach`'s warm-restore branch:

1. `resize` — do it first, so the repaint it provokes is either captured by the
   snapshot or arrives on the stream with a higher seq.
2. `subscribe` on the stream socket — from here on, nothing is lost.
3. `getSnapshot` on the control socket — returns the screen and its seq.

Duplicates are now possible by design (anything delivered between subscribe and
snapshot is in both), and that is fine: they carry seqs at or below the
snapshot's, and the renderer drops them in ticket 5.

## Files to touch
- `electron/terminal-host/client.ts` — reorder the branch at `doCreateOrAttach`
  (~line 186). Keep using `getSnapshot` rather than the `attach` control request:
  `attach` would add the *control* socket to the session's broadcast list and
  corrupt the control protocol. Update the comment, which currently explains the
  old ordering.
- `electron/terminal-host/client.test.ts` — the fake daemon asserts on request
  order; update it and add a case pinning the new order.
- `electron/terminal-host/daemon.integration.test.ts`, `e2e.test.ts` — fake
  daemons in these files answer `getSnapshot`; make sure they supply `seq`.

## Notes
- The cold-create path (no existing session) is unchanged: it subscribes and
  returns no snapshot.
- Do not drop the `createNoSubscribe` path's behavior while editing nearby.
