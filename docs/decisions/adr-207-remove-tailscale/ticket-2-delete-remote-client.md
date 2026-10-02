---
title: Delete the remote client and the loopback listener
status: in-progress
priority: high
assignee: opus
blocked_by: [1]
---

# Delete the remote client and the loopback listener

ADR-207 D2 and D3. After this ticket, remote control opens no listening socket.
The relay is the only way in.

Tiers and `via` stay for now (ticket 3). If a tier check lived only in the HTTP
surface, it goes with it. The bridge 4403 tier check moves to the gate unchanged.

E2E specs that open the loopback `/app` will be broken after this ticket.
Ticket 3 moves them to the relay setup. Do not run Playwright, but make sure
`tests/e2e` still typechecks if it is in a tsconfig.

## Steps

### 1. RelayGate (new: `electron/remote-control/relay-gate.ts`)

Read `server.ts` first. The relay uses `authenticateRelayHello` (:316-357),
`closeDevice` and `running`; `controller.ts` uses `server.*`;
`relay/connector.ts` calls `bridge.attach(socket, auth)`.

- Move into the gate:
  - device verification;
  - the `AuthRateLimiter` failed-auth backoff (`rate-limit.ts`; trim its
    HTTP/IP wording);
  - the `AuthenticatedDevice` type;
  - `closeDevice(id)`, which closes that device's attached bridge connections.
- Keep the road check (`via`) and the 4403-for-non-full behaviour exactly as
  they are; ticket 3 removes them.
- The controller's `enabled` becomes its own flag instead of `server.running`.
  `setEnabled(true)` loads the runtime and no longer starts a listener.
- In `status()`, remove `port`. `listeners` collapses to the relay viewer count
  (keep `relayViewers` or rename; update the renderer to match).
- `relay/connector.ts` and its tests take the gate instead of a
  `RemoteControlServer`.
- `app-lifecycle.ts` `loadRemoteControlRuntime` builds the gate instead of the
  server.

### 2. Delete the listener

- Delete:
  - `electron/remote-control/server.ts`, `static.ts`, `sse.ts`,
    `listener-routes.ts` and `allowlist.ts`;
  - their tests: `server.test.ts`, `static.test.ts`, `allowlist.test.ts`.
- `allowlist.test.ts` has a LOCAL_ONLY assertion block (:240-262 or so). If
  that coverage isn't already in a bridge test, move it there first.
- The relay hello gate tests in `server.test.ts` (around :814-836) move to a new
  `__tests__/relay-gate.test.ts`, along with the auth and backoff tests that
  still apply.
- `WEB_CSP` and `webContentType` live in `src/lib/web-headers.ts` and are still
  used by the relay and `vite.web.config.ts`. Keep them, and fix the header
  comment.

### 3. Bridge transport (`electron/bridge/transports/ws.ts`)

- Delete `handleUpgrade`, `BRIDGE_PATH` and the `ws` `WebSocketServer`. Keep
  `attach`.
- Fix the `AuthenticatedDevice` import.
- `ws-bridge.test.ts` ran over the real listener `/ws`. Re-host its invoke,
  events and layout coverage on `attach` with an in-memory or paired
  `FrameSocket`. Do **not** just delete it. Drop only the cases that tested
  the HTTP upgrade itself.
- If `ws` stops being imported anywhere in `electron/`, check knip and
  `package.json` (the relay connector may still use it).

### 4. Push

The HTTP `POST /push/subscribe` route goes with `listener-routes.ts`. The bridge
`remoteControl.subscribePush`/`vapidPublicKey` stays. Fix the HTTP mention in
the `devices.setPushSubscription` doc.

### 5. Web app

The relay origin is the only server, so delete the loopback pairing path:

- `src/bridge/web-pairing.ts`: `mode: "listener"` (around :62, 68, 122,
  194-215).
- `src/bridge/transports/ws.ts`: `webSocketPipe`, `bridgeUrlFromLocation` and
  `WEB_TOKEN_KEY`, if they are only used by listener mode.
- `src/bridge/install-web.ts`: the listener branch (around :50-71).

Update their tests:

- `src/bridge/__tests__/web-pairing.test.ts`
- `install-web-relay.test.ts` ("never redirects a listener-served page")
- `ws.test.ts`

Keep the relay path intact.

### 6. Remote client and build

- Delete `src/remote-client/` and `vite.remote.config.ts`.
- Move `src/remote-client/public/icons` into the web app's public dir and fix
  `vite.web.config.ts:27` and its comments (:105-126).
- `package.json`:
  - Drop the remote vite build from `dev`/`build`.
  - Drop the `test:e2e:remote`, `e2e:remote` and `e2e:remote:watch` scripts.
  - Check whether `dist-electron/web` (the listener's web build) is still
    needed by anything. The relay serves `dist-relay-web/` from
    `pnpm build:web:relay`. If nothing else uses the `dist-electron/web` build
    step, drop it from `dev`/`build` as well, along with any packaging
    `files`/`extraResources` entries.
- `knip.json`: remove the remote-client entries.
- `.claude/agents/verifier.md` says "three bundles (app, remote, web)". Update
  it to say what `pnpm build` now builds.

### 7. Renderer

- Remove `port` from the status type and the store's empty status.
- `RemoteControlPage.tsx`: delete the loopback-address line
  (`remote-listener-address`). The switch copy ("Manor runs a second,
  authenticated listener while this is on") must change: nothing listens
  locally.
- `RemoteControlDialogs.tsx` `PairingResultDialog`: delete the `port` prop and
  the loopback link. It shows only the relay pairing URL and QR.
- MCP `set_remote_control_enabled` and the status text in
  `electron/mcp/tools-system.ts`: remove "local listener" and port wording.

### 8. E2E

- Delete `tests/e2e/remote-control.spec.ts`.
- In `tests/e2e/helpers/phone.ts`, delete `openPhoneClient` and `sessionRow`.
- Leave `openWebApp` and `enableRemoteControl` for ticket 3 to rewrite. Only
  make them compile.
- Update the remote-client sections of `tests/e2e/README.md`.

## Files to touch
- new `electron/remote-control/relay-gate.ts`, `__tests__/relay-gate.test.ts`
- delete: `electron/remote-control/server.ts`, `static.ts`, `sse.ts`, `listener-routes.ts`, `allowlist.ts` and their tests; `src/remote-client/**`; `vite.remote.config.ts`; `tests/e2e/remote-control.spec.ts`
- `electron/remote-control/controller.ts`, `rate-limit.ts`, `push.ts`, `devices.ts` (doc), `relay/connector.ts`, `relay/__tests__/connector.test.ts`, `__tests__/controller.test.ts`, `__tests__/relay-reset.test.ts`, `__tests__/ws-bridge.test.ts`, `__tests__/audit.test.ts` (comment)
- `electron/app-lifecycle.ts`, `electron/bridge/transports/ws.ts`, `electron/mcp/tools-system.ts` (+ test)
- `src/bridge/web-pairing.ts`, `src/bridge/transports/ws.ts`, `src/bridge/install-web.ts` and their tests
- `src/electron.d.ts`, `src/store/remote-control-store.ts`, `src/components/settings/RemoteControlPage.tsx`, `RemoteControlDialogs.tsx`, `src/components/statusbar/StatusBar/remote-exposure.ts` (+ test)
- `src/lib/web-headers.ts` (comment), `vite.web.config.ts`, `package.json`, `knip.json`, `.claude/agents/verifier.md`
- `tests/e2e/helpers/phone.ts`, `tests/e2e/README.md`
