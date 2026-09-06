---
title: Regression tests for daemon loss and subscription reconciliation
status: done
priority: high
assignee: sonnet
blocked_by: [2]
---

# Regression tests for daemon loss and subscription reconciliation

Add a `describe("daemon loss (ADR-169)")` block to `electron/terminal-host/client.test.ts` using the existing `TestDaemon` and `createTestClient` helpers. `TestDaemon.start()` can be called again after `stop()` (same socket path, fresh `TerminalHost`) — extend it if needed so a restart yields an empty session table.

Tests:

1. **lost session → exit event**: connect; `createOrAttach("s1", …)`; register `client.onEvent` collector; `await daemon.stop()`; `await daemon.start()` (new empty host); wait up to ~3 s for the client to reconnect; assert an event `{ type: "exit", sessionId: "s1" }` was delivered exactly once and `await client.ping()` is true.
2. **socket drop, session alive → re-subscribed**: connect; `createOrAttach("s2", …)`; destroy the client's control and stream sockets directly (as the existing `handleDisconnect` test does); wait for reconnect; drive output from the fake subprocess of `s2` (see the existing "stream events" test for how output is injected) and assert a `data` event for `s2` arrives; assert no `exit` was emitted for `s2`.
3. **closed sessions are forgotten**: connect; `createOrAttach("s3", …)`; `await client.kill("s3")`; force a disconnect/reconnect; assert no `exit` event for `s3` is emitted.
4. **reconnect gives up → exit for all**: connect; `createOrAttach("s4", …)`; `await daemon.stop()` and do not restart; make `spawnDaemon`/`connect` fail (the `createTestClient` stubs `spawnDaemon` to resolve, so patch `connectControlSocket` to reject); assert `exit` for `s4` arrives after the retries. Use `vi.useFakeTimers()` or shorten the backoff via a private override so the test stays fast.

Run `npx vitest run electron/terminal-host/client.test.ts`.

## Files to touch
- `electron/terminal-host/client.test.ts` — new describe block; small `TestDaemon` restart support if needed
