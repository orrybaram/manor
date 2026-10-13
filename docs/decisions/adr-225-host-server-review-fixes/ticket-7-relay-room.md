---
title: Shared RelayRoom for desktop controller and host relay
status: in-progress
priority: medium
assignee: opus
blocked_by: [6]
---

# Shared RelayRoom for desktop controller and host relay

`electron/host-server/relay.ts` duplicates `electron/remote-control/controller.ts`:

| op | relay.ts | controller.ts |
|---|---|---|
| pair | 208-224 | 249-275 |
| revoke + close loop | 200-205 | 342-345, 363-366 |
| reset order | 299-309 | 334-352 |
| revoke devices from stale room | 244-252 | 360-372 |

(line numbers from before tickets 1–6; re-locate.) The host's `resetIdentity` isn't serialised — the controller uses `serially` — so two concurrent resets can interleave across `await flush`.

## Do

1. Extract `electron/remote-control/relay-room.ts`: a `RelayRoom` holding identity store, device store, gate, connector and push, exposing `pair`, `revoke`, `revokeAll`, `reset`, `revokeStale`, all serialised (reuse the existing `serially` helper). Electron-free.
2. Desktop controller keeps its enable/disable, lazy-load and notice policy and delegates room ops to `RelayRoom`. Host relay keeps always-on and its retry-after-failure, delegating to `RelayRoom`.
3. Durability semantics from ticket 1 (await flush before acknowledging pair/revoke) live in `RelayRoom`.
4. Tests: move duplicated relay-room behaviour tests to `remote-control/__tests__/relay-room.test.ts`; add a concurrent-reset test. Keep `controller.test.ts` and host relay tests green.

## Files to touch
- `electron/remote-control/relay-room.ts` (new), `controller.ts`
- `electron/host-server/relay.ts`, `server.ts` (if wiring changes)
- `electron/remote-control/__tests__/relay-room.test.ts` (new), `controller.test.ts`, `electron/host-server/__tests__/host-server.test.ts`

## Added from ticket 2

5. `RemoteControlController`'s constructor is now `(loadRuntime, deviceStore, push = null, appVersion = "0.0.0", hostPushEndpoints = () => EMPTY_SET)` — five positional params with optional tails. When restructuring it around `RelayRoom`, take a single options object.
