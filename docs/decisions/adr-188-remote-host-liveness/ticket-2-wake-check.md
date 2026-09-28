---
title: Enable the heartbeat for remote hosts and check them on wake
status: done
priority: high
assignee: sonnet
blocked_by: [1]
---

# Enable the heartbeat for remote hosts and check them on wake

See ADR-188 §3. Depends on ticket 1, which adds
`TerminalHostClient.setHeartbeat` and `checkLiveness`.

## Steps

1. `electron/backend/remote-backend.ts`
   - Constants `HEARTBEAT_INTERVAL_MS = 15_000` and
     `HEARTBEAT_TIMEOUT_MS = 10_000`, with a doc comment explaining why: ssh
     keepalives only catch a dead peer, not a live-but-wedged pipe (ADR-188).
   - In the constructor, after `setReconnectPolicy`, call
     `this.client.setHeartbeat({ intervalMs, timeoutMs })`. Allow overriding
     via `RemoteBackendOptions.heartbeat?: { intervalMs; timeoutMs } | null`
     (for tests), in the same style as `reconnectDelayMs`.
   - Add `checkLiveness(): Promise<boolean>`, delegating to the client.
2. `electron/backend/types.ts`: add `checkLiveness(): Promise<boolean>` to
   `RemoteHostBackend`, with a doc comment. Update any fakes implementing it
   (grep tests for `retryNow` implementations of `RemoteHostBackend` and add
   `checkLiveness` next to them).
3. `electron/backend/host-connection.ts`: add
   `RemoteHostConnection.checkLiveness(): void`.
   - `connected`: `void this.backend.checkLiveness()`. Failure is handled
     inside the client, which reports `hostDisconnected`.
   - `reconnecting`: `this.backend.retryNow()`.
   - Otherwise do nothing.
4. `electron/backend/registry.ts`: add `checkRemoteHosts(): void`, calling
   `checkLiveness()` on every `RemoteHostConnection` (see how
   `remoteHostIds()` / `this.hosts` are iterated; use an `instanceof` check or
   whatever the file already uses to tell remote from local).
5. `electron/app-lifecycle.ts`: inside the `app.whenReady()` setup, after
   `backendRegistry` exists, subscribe
   `powerMonitor.on("resume", …)` and `powerMonitor.on("unlock-screen", …)` to
   call `backendRegistry.checkRemoteHosts()`, with a `console.log` line
   `[power] resume: checking remote hosts`. Import `powerMonitor` from
   `electron`. `powerMonitor` must not be used before `ready`.

## Tests
- `host-connection` / `registry` tests (find the existing test files): with
  `connected`, `checkLiveness` calls the backend's `checkLiveness`; with
  `reconnecting`, it calls `retryNow`; with `error`/`disconnected`, it calls
  neither.
- `remote-backend` test (if one exists): the heartbeat is configured on the
  client.

Run the relevant vitest files and the typecheck.

## Files to touch
- `electron/backend/remote-backend.ts`: enable the heartbeat, add `checkLiveness`
- `electron/backend/types.ts`: `RemoteHostBackend.checkLiveness`
- `electron/backend/host-connection.ts`: `RemoteHostConnection.checkLiveness`
- `electron/backend/registry.ts`: `checkRemoteHosts`
- `electron/app-lifecycle.ts`: `powerMonitor` wiring
- related `*.test.ts` fakes/tests
