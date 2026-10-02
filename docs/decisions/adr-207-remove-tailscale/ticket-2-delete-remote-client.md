---
title: Delete the remote client and the listener's HTTP surface
status: todo
priority: high
assignee: opus
blocked_by: [1]
---

# Delete the remote client and the listener's HTTP surface

ADR-207 D2 and D3. After this ticket, the loopback listener in
`electron/remote-control/server.ts` serves only these things. It still binds
`127.0.0.1:0`.

| Path | What it serves |
|---|---|
| `GET /app`, `/app/*` | The web app, unauthenticated static files, from `dist-electron/web` |
| `/ws` upgrade | The bridge, handled by `WsBridgeServer.handleUpgrade` |
| Any other path | 404 |

`RemoteControlServer` keeps these:

- `authenticateBridge`
- `authenticateRelayHello`
- the `AuthRateLimiter`
- `closeDevice`
- `running`
- `listenerCount`, which now counts bridge sockets only

## Steps

1. Delete the remote client.
   - Delete `src/remote-client/` and `vite.remote.config.ts`.
   - Move `src/remote-client/public/icons` to `src/web/public/icons` (or the web
     app's own public dir) and fix `vite.web.config.ts:27`. Fix its comments
     at :105-126.
   - `package.json`: drop the `vite build --config vite.remote.config.ts` steps
     from `dev`/`build`, and the `test:e2e:remote`, `e2e:remote` and
     `e2e:remote:watch` scripts.
   - `knip.json`: remove the remote-client entries.
2. Delete the listener's HTTP route surface.
   - Delete `electron/remote-control/sse.ts`, `listener-routes.ts` and
     `allowlist.ts` (plus `__tests__/allowlist.test.ts`).
   - Before deleting `allowlist.test.ts`, move its LOCAL_ONLY assertion block
     (:240-262) into a bridge test. Drop the tunnel names from it.
3. Trim `static.ts` to the web-app half and update `__tests__/static.test.ts`.
   Delete it if nothing remains worth testing.
4. `server.ts`:
   - Remove `serveClientAsset`, `/events`, `listenerRoutes`,
     `remoteRouteTable`, `guardWrites`/`guardedWrite` and the
     `SEND_ROUTE`/`INTERRUPT_ROUTE`/`LAUNCH_ROUTE`/`ALLOWED_METHODS` constants.
   - Remove the SSE hub and `publishStatus` if it only feeds SSE. Check the
     controller.
   - Keep the bridge 4403 tier check for now; ticket 3 removes tiers.
   - Rewrite the header comment.
5. Push: delete HTTP `POST /push/subscribe` (it lived in listener-routes). The
   bridge `remoteControl.subscribePush`/`vapidPublicKey` stays. Fix the HTTP
   mention in the `devices.setPushSubscription` doc.
6. `server.test.ts`: delete the HTTP and tier describes (route surface, send
   and launch gates, the full tier over HTTP, served client, `/me`,
   `/workspaces`, `/push/subscribe`, `/events`). Keep or adapt:
   - binding
   - authentication on `/ws`
   - rate limiting
   - the relay hello gate
   - request hygiene, if it is still relevant
   - a test that `/` and unknown paths 404 while `/app` serves
7. `ws-bridge.test.ts`: delete "upgrades nothing outside /ws" only if the
   behaviour changed. Keep the invoke/events/layout coverage.
8. E2E:
   - Delete `tests/e2e/remote-control.spec.ts`.
   - In `tests/e2e/helpers/phone.ts`, delete `openPhoneClient` and `sessionRow`.
   - Update `tests/e2e/README.md` sections about the remote client and
     `dist-electron/remote/`.
9. Fix comments that mention the remote client in `src/lib/web-headers.ts`,
   `rate-limit.ts` and `audit.test.ts`.

## Files to touch
- `src/remote-client/**`, `vite.remote.config.ts` — delete
- `vite.web.config.ts`, `package.json`, `knip.json`
- `electron/remote-control/server.ts`, `static.ts`, `sse.ts`, `listener-routes.ts`, `allowlist.ts`, `rate-limit.ts`, `push.ts`, `devices.ts` (doc only)
- `electron/remote-control/__tests__/server.test.ts`, `static.test.ts`, `allowlist.test.ts`, `ws-bridge.test.ts`, `audit.test.ts`
- a bridge test that keeps the LOCAL_ONLY assertions
- `tests/e2e/remote-control.spec.ts` (delete), `tests/e2e/helpers/phone.ts`, `tests/e2e/README.md`
- `src/lib/web-headers.ts` (comment)
