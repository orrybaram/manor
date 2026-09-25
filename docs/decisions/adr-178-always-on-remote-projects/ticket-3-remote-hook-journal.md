---
title: Hook journal on the remote daemon with replay
status: todo
priority: critical
assignee: opus
blocked_by: []
---

# Hook journal on the remote daemon with replay

**Prerequisite:** ADR-160 tickets 8 and 9, plus the *bootstrap* part (step 3) of ADR-160
ticket 10. This ticket **replaces** ADR-160 ticket 10 steps 1, 2 and 4 (the `ssh -R`
reverse forward and its diagnostic).

Hook events fired while the laptop is closed must not be lost (ADR-178 §2).

### Daemon side
1. `electron/terminal-host/hook-listener.ts` (new): loopback-only HTTP listener started
   by the daemon **only when launched for remote use** (a flag set by `remote-bridge`
   bootstrap, persisted so a daemon restarted on the box keeps it). Port written to
   the box's `hook-port` file (reuse `hookPortFile()` from `electron/paths.ts`).
   Accept the same request shape `AgentHookServer` accepts (read `electron/agent-hooks.ts`).
2. Journal: append `{ seq, receivedAt, payload }` to `~/.manor/daemon/hook-journal.ndjson`
   (mode 0600). `seq` is monotonic across daemon restarts (recover last seq from the
   file tail on start). Cap at 5,000 entries or 7 days, compacting on start and every
   N appends.
3. Emit `StreamEvent` `{ type: "hookEvent", seq, payload }` to all stream sockets.
4. Control request `{ type: "replayHooks", sinceSeq }` →
   `{ type: "hookReplay", entries, lastSeq }`. Add both to `terminal-host/types.ts`.
5. PTYs on this daemon spawn with `MANOR_HOOK_PORT` = the listener's port (set at the
   daemon, not via `updateEnv` from main). **Also stop the remote client from pushing the
   laptop.s env** — today `TerminalHostClient` re-sends `MANOR_HOOK_PORT`, `MANOR_WEBVIEW_PORT`
   and `MANOR_PORTLESS_PORT` via `updateEnv` on every connect, including to remote daemons,
   which would override the daemon.s own listener. Add a client option (e.g. `pushLocalEnv:
   false`) used by `RemoteBackend`.

### Main side
6. Factor the body of `AgentHookServer`'s request handler into
   `ingestHookPayload(payload, { hostId })` in `electron/agent-hooks.ts`; the local HTTP
   server calls it too. No local behavior change.
7. Per remote host, persist `lastHookSeq` (alongside host specs). On connect:
   buffer live `hookEvent`s, call `replayHooks(lastHookSeq)`, ingest replayed entries in
   order, then drain the buffer skipping `seq <= lastSeq`. Update `lastHookSeq` after
   each ingest. Ordering matters: the late-active guard in `hook-relay-transition.ts`
   assumes in-order delivery.
8. Notification coalescing on replay: while replaying, suppress OS notifications and
   emit at most one per agent reflecting its final state.

Tests: journal seq recovery and capping; replay-then-live ordering with interleaved
events; coalesced notifications.

## Files to touch
- `electron/terminal-host/hook-listener.ts` — new.
- `electron/terminal-host/hook-journal.ts` — new.
- `electron/terminal-host/index.ts` — start listener in remote mode, `replayHooks`.
- `electron/terminal-host/types.ts` — `hookEvent`, `replayHooks`, `hookReplay`.
- `electron/terminal-host/session.ts` — `MANOR_HOOK_PORT` in spawn env for remote mode.
- `electron/agent-hooks.ts` — extract `ingestHookPayload`.
- `electron/backend/registry.ts` — replay on connect, `lastHookSeq` persistence.
