---
title: Signal which sessions a daemon replacement is about to kill
status: done
priority: high
assignee: sonnet
blocked_by: [1]
---

# Signal which sessions a daemon replacement is about to kill

Read ADR-185 `index.md` §A.1.

1. In `electron/terminal-host/client.ts` `doConnect`, when `isDaemonStale`
   is true and before `this.cleanup()` / `transport.restart()`, request
   `listSessions` from the stale daemon (reuse the existing request type the
   `pty.listSessions` path uses; short timeout; on any error treat as empty).
   Collect alive session ids and invoke a new optional constructor/option
   callback `onDaemonReplacing?: (sessionIds: string[]) => void` (match how the
   client's other options are passed). Guard with `stillWanted()` like the
   surrounding code. Invoke even for an empty list? No — only when non-empty.
2. In `electron/backend/host-connection.ts`, pass that callback when creating
   the client and forward it as a new context emitter, modelled on
   `this.ctx.resumed.emit(this.hostId, sessionIds)` — e.g.
   `this.ctx.daemonReplacing.emit(this.hostId, sessionIds)`.
3. In `electron/backend/registry.ts`, add the matching emitter and a public
   subscription (`onDaemonReplacing(listener)`), modelled on how `resumed` is
   exposed. Session ids are pane ids (see `agent-persistence.ts` notes).
4. Tests: in `electron/terminal-host/client.test.ts`, a stale handshake with two
   live sessions calls `onDaemonReplacing` with both ids before `restart`; a
   non-stale handshake never calls it; a `listSessions` failure still restarts.

## Files to touch
- `electron/terminal-host/client.ts` — list + callback before restart
- `electron/terminal-host/client.test.ts` — tests
- `electron/backend/host-connection.ts` — forward callback
- `electron/backend/registry.ts` — event + subscription
