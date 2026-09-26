---
title: Split terminal-host client into focused modules
status: done
priority: high
assignee: opus
blocked_by: [3]
---

# Split terminal-host client into focused modules

Read `index.md`. `electron/terminal-host/client.ts` has grown to about 1300
lines. Split it with no change in behaviour:

1. **`reconnect-supervisor.ts`**: `reconnectAfterLoss`, `reconnectDelay`,
   `retryReconnectNow`, `sleepBeforeReconnect`, `notifyListener`,
   `recoveryPending`, `wakeReconnect` and the policy fields. It takes a
   `connect()` callback and a `ConnectionListener`.
2. **`rpc-channel.ts`**: NDJSON framing, `pendingRequests`, `requestMutex`,
   `doRequest`/`requestConcurrent` and `requestId` matching.
   - Expose one typed `call<K>(req): Promise<ResponseFor<K>>` that throws on an
     `error` response or on the wrong response type. It uses ticket 3's
     `ResponseFor`.
   - Also expose `callConcurrent`.
   - Every public client method then becomes 2–3 lines. That deletes the
     hand-written `resp.type === "error" ? … : unexpected response type` ladder,
     which appears about 7 times.
3. **`exec-stream-registry.ts`**: exec/execStream stream bookkeeping, with
   `dispatch(event)` and `failAll(reason)`.
4. **`client.ts`** keeps the session facade and `doConnect`.
   - Merge the duplicated auth request/check blocks (the normal path and the
     respawn path) into one `authenticate()`.
   - Remove the duplicated `isDaemonStale` docstring text in `doConnect`.
5. **`onEvent` returns an unsubscribe.** Change `PtyBackend.onEvent` (and the
   client's) to return `() => void`. Update the callers that currently drop
   the handle: `registry.ts` views and `RoutedBackend.pty.onEvent`/`onHostEvent`.
   Delete any per-host view overrides that have no production caller.

6. **Drop old-daemon comments.** Trim the comments that still describe tolerating old daemons ("Absent from daemons that predate it" on `HookReplay.epoch`, the handshake `protocol` field and similar). The version handshake replaces older daemons.

`client.ts` must end up under 600 lines, and no new file over 500. Run
`pnpm build` and the terminal-host tests.

## Files to touch
- `electron/terminal-host/client.ts`
- `electron/terminal-host/reconnect-supervisor.ts`, `rpc-channel.ts`, `exec-stream-registry.ts` (new)
- `electron/backend/types.ts`, `electron/backend/routed-backend.ts`, `electron/backend/registry.ts`, `electron/backend/local-pty.ts` (the `onEvent` signature)
- related tests (split `client.test.ts` to match if that helps)
