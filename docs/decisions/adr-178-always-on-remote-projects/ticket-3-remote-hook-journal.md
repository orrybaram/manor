---
title: Hook journal on the remote daemon with replay
status: done
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

## Implementation notes

- **Remote mode flag.** The daemon's `bootstrap` request (sent only by `RemoteBackend`)
  writes `~/.manor/daemon/remote-mode` and starts the hook listener. A daemon that
  finds the file at startup starts the listener itself, so a daemon restarted on the
  box (crash, reboot) keeps journaling before any client reconnects. A local daemon
  never receives `bootstrap` and never listens. `bootstrapped` now carries `hookPort`.
- **Listener** (`terminal-host/hook-listener.ts`) binds 127.0.0.1, writes `hook-port`,
  sets `MANOR_HOOK_PORT` in the daemon's `process.env` (so `session.ts` needed no
  change: spawn env is `process.env` + overrides), and while it runs the daemon ignores
  `MANOR_HOOK_PORT` in `updateEnv`. No auth token, like `AgentHookServer`. Both
  listeners share `hookRequestParams`/`parseAgentHookEvent` (`agent-hook-events.ts`).
- **Journal payload** is the request's query parameters (`HookPayload`), i.e. the wire
  form; main re-parses via `AgentHookServer.ingestHookPayload`.
- **Journal** keeps a watermark line (no payload) at the top on every compaction so
  the seq survives even when every entry has aged out. Compaction rewrites via
  tmp + rename on open (dropping any torn last line), every 500 appends, and on
  shutdown.
- **Main side** lives in `backend/hook-feed.ts` (`HostHookFeed`, one per remote host,
  owned by `BackendRegistry`; `NotificationCoalescer`). `hookEvent`s are routed to the
  feed and never reach `onEvent` listeners/renderers. A live event that skips a seq
  triggers a catch-up rather than out-of-order ingest; a journal behind `lastHookSeq`
  is treated as reset (replay from 0). `lastHookSeq` is persisted in projects.json,
  debounced 1s, flushed on quit.

### Review fixes

- **Own daemon namespace.** `remote-bridge` (and `manor-host restart`) now use
  `LocalTransport({ namespace: "remote" })`: the daemon lives in
  `~/.manor/remote/daemon/` (socket, token, pid, log, journal) and is spawned
  with `--namespace remote`; its listener publishes `~/.manor/remote/hook-port`.
  A Manor desktop daemon on the same box (or `ssh localhost`) keeps
  `~/.manor/daemon/` and `~/.manor/hook-port` to itself. Remote mode is implied
  by the namespace (the listener starts at daemon startup; `bootstrap` just
  reports the port), so the `remote-mode` flag is gone; a local daemon deletes
  a stale `~/.manor/daemon/remote-mode` on start and answers `replayHooks` as
  a daemon without a journal. Paths: `DaemonNamespace`, `daemonDir(ns)` & co.,
  `remoteNamespaceDir`, `remoteHookPortFile`, `daemonLogFile` in `paths.ts`.
- **Hook script endpoint.** The listener sets `MANOR_HOOK_PORT_FILE` (plus
  `MANOR_HOOK_PORT`) in the daemon env. `agent-hook.js` (and the pi extension)
  read `MANOR_HOOK_PORT_FILE` if set, else `~/.manor/hook-port`, else
  `MANOR_HOOK_PORT` — unchanged for local panes. A remote pane never falls
  back to the desktop's port file.
- **Listener token.** The remote port file is `<port>\n<token>` (0600, dir
  0700); the script sends the token as `x-manor-hook-token`, and the listener
  answers 403 without it. The local port file format and `AgentHookServer`
  are unchanged, except that `AgentHookServer.stop()` now only unlinks the
  port file if it still names its own port.
- **Cursor with epoch; first contact.** The journal mints a random `epoch` on
  creation, kept in the watermark line; `hookReplay` carries it and
  `replayHooks` takes `headOnly`. Main stores `{ seq, epoch }` per host
  (`lastHookSeq` + `hookJournalEpoch` in projects.json; `HookSeqStore.get`
  returns null for a never-met journal). First contact fast-forwards to the
  journal head without ingesting (no phantom agents from old SessionStarts).
  An epoch mismatch (or, without epochs, a head behind the cursor) is a
  recreated journal, which holds only post-reset hooks: replay it all. A
  cursor from before epochs adopts the journal's epoch.
- **Routing replayed hooks.** Before each catch-up the registry lists the
  host's sessions and records ownership of any not already owned, so
  `RelayAgentHook` effects of replayed hooks route to the remote daemon on a
  fresh launch instead of falling back to local.
- **Torn line after failed compaction.** If `open()`'s rewrite fails, the
  journal truncates the file to its last newline (or, if that fails too,
  starts the next append with a newline), and appends a watermark so a newly
  minted epoch survives.
- Not handled: a daemon from before this change already running in
  `~/.manor/daemon/` on a dev box keeps running until killed; the new
  `restart` only stops the remote-namespace daemon.
