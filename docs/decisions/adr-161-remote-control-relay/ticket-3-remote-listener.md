---
title: Authenticated remote-control listener
status: done
priority: critical
assignee: opus
blocked_by: [1, 2]
---

# Authenticated remote-control listener

A second `http.Server`, off by default, serving only the allowlisted routes and only to
authenticated devices. `electron/webview-server.ts` is **not modified** — the local
loopback surface keeps its current no-auth behavior because its exposure does not change.

`electron/remote-control/server.ts`:

- `start(deps: ControlDeps, devices: RemoteDeviceStore): Promise<{ port: number }>` —
  binds `127.0.0.1` on a random port. It stays loopback-bound even when enabled; reaching
  it from outside is the tunnel's job (ticket 5).
- Request order is fixed and must not be rearranged: (1) method/size sanity, (2) extract
  bearer token from `Authorization`, (3) `devices.verify()` — on failure record a
  rate-limit hit and return 401 **before reading the body**, (4) `Origin`/`Host` check as
  defence in depth, (5) dispatch against `remoteRouteTable(routes, device.canSend)`.
- Reuse `dispatch()` from `electron/routes/router.ts` and the existing `ControlDeps` —
  no route handler is duplicated or reimplemented.
- Body size cap (1 MB) and a request timeout.
- Never echo the presented token in a response or a log line. Log the device `id` and
  `label`, never the hash.
- `GET /events`: token-authenticated Server-Sent Events streaming agent status changes.
  Source it from the same signal `app-lifecycle.ts` already uses to update the dock badge
  and OS notifications rather than polling. Heartbeat comment every 20s so proxies do not
  idle it out. Clean up listeners on client disconnect.
- `stop()` closes the server and every open SSE connection.

Wire construction (not enablement) in `electron/app-lifecycle.ts` alongside the other
managers. Default state is stopped.

Tests: an unauthenticated request gets 401 and never reaches a handler; a valid token
reaches an allowlisted route; a valid token for a non-allowlisted path gets 404 (not 403,
because the route is absent); a `canSend: false` device cannot reach `POST /sessions/send`;
SSE emits on status change and cleans up on disconnect.

## Files to touch

- `electron/remote-control/server.ts` — new.
- `electron/remote-control/sse.ts` — new; SSE connection registry and heartbeat.
- `electron/app-lifecycle.ts` — construct the server and the device store; keep stopped.
- `electron/remote-control/__tests__/server.test.ts` — new.
