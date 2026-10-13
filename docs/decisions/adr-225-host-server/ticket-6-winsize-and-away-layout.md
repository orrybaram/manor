---
title: Daemon-decided winsize owner and the "Started while away" tab
status: done
priority: medium
assignee: sonnet
blocked_by: [4]
---

# Daemon-decided winsize owner and the "Started while away" tab

ADR-225 D5.

- Daemon: add `attachedClients: number` to session info (`electron/terminal-host/session.ts:110` already has the map). This is additive, so no protocol bump (see ADR-189's compatibility note).
- Host server `pty.create` for a device:
  - It is a follower (`{winsizeOwner:false, cols, rows}`) when the session has any other attached client, and the owner otherwise.
  - Push `pty.winsizeOwner` when that changes (poll the attach count on attach and detach events, or have the daemon emit an event).
- Host server `layout` reads: return the synced snapshot. Append a synthetic tab "Started while away" holding any daemon session for a manifest workspace that the snapshot lacks.
- `layout.save` and other mutating layout calls from a device are refused with a named state, so the renderer shows its toast and does not error.

## Files to touch
- `electron/terminal-host/session.ts`, `terminal-host.ts`, `types.ts`
- `electron/host-server/handlers.ts`, `electron/host-server/layout.ts` (new)
