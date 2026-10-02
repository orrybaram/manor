---
type: adr
status: proposed
database:
  schema:
    status:
      type: select
      options: [todo, in-progress, review, done]
      default: todo
    priority:
      type: select
      options: [critical, high, medium, low]
    assignee:
      type: select
      options: [opus, sonnet, haiku]
  defaultView: board
  groupBy: status
---

# ADR-207: The relay is the only road — removing Tailscale, the tiers and the remote client

Supersedes ADR-206 D6 ("Tailscale stays") and the consequence "Watch/Reply
devices still need Tailscale". ADR-161's tunnel tickets are history.

## Context

Remote control has two ways to reach the machine. `tailscale serve` exposes the
loopback listener on the user's tailnet (ADR-161). The end-to-end encrypted
relay (ADR-206) needs no install and no account. Supporting both costs a lot:

- **A tunnel subsystem.** `electron/remote-control/tunnel.ts` and
  `tunnel-status.ts` spawn and parse `tailscale serve` / `tailscale status`.
  `app-lifecycle.ts` has a shim for the app-bundled CLI and an
  `process.on("exit")` kill hook. There are `start_tunnel`/`stop_tunnel` MCP
  tools and CLI commands, `/remote-control/tunnel/*` routes, a Homebrew installer
  terminal, a "Serve not enabled" admin-console flow and a tailnet device list.
  The badge and the status bar each handle two roads.
- **Two pairing roads.** `PairedVia = "tailscale" | "relay"` and a road gate in
  `server.authenticateBridge` that stops the relay from becoming an oracle for
  Tailscale tokens.
- **Three capability tiers.** `read`/`send`/`full` (Watch/Reply/Everything)
  exist only because a Tailscale device can use the lightweight **remote
  client** (`src/remote-client/`, served at `/`). That client talks to an
  allowlisted HTTP surface: `allowlist.ts`, `guardWrites`, `listener-routes.ts`,
  `sse.ts`, `static.ts` and HTTP `/push/subscribe`. The relay only pairs `full`.

The relay already covers the main use case (phone on cellular, scan a QR). The
web app covers everything the remote client did. Push to relay devices goes over
the bridge (ADR-206 D7). We are removing Tailscale.

## Decision

**D1 — Delete the tunnel.** Delete `tunnel.ts`, `tunnel-status.ts` and their
tests. `TunnelState` moves into `relay/connector.ts` as `RelayState`. Also
delete:

- the tunnel and tailnet parts of `RemoteControlController`: `installed`,
  `tailnet`, `refreshDetection`, `startTunnel`/`stopTunnel`, `killTunnelNow` and
  the `which` dependency;
- the bridge handlers `startTunnel`, `stopTunnel` and `refreshDetection`, and
  their local-only and unavailable entries;
- the `/remote-control/tunnel/*` and `/remote-control/refresh` HTTP routes;
- the `start_tunnel`/`stop_tunnel` MCP tools, which also removes them from the
  CLI;
- the status fields `tunnel`, `installed` and `tailnet`;
- in the UI: `ConnectionCard`, `TailnetDevices`, the installer and
  `TunnelConfirmDialog`;
- the tunnel road in `remote-exposure.ts` and `RemoteExposureIndicator`.

**D2 — Delete the remote client and the loopback listener.** Once the tunnel is
gone, nothing outside the machine can reach the listener. Its only remaining
users are the "Link (this machine only)" link and three e2e specs, so it goes
too. Delete:

- `src/remote-client/` and `vite.remote.config.ts`. Their icons move to the
  web app's own public dir, because `vite.web.config.ts` borrows them.
- `electron/remote-control/server.ts`, `static.ts`, `sse.ts`,
  `listener-routes.ts` and `allowlist.ts`, along with their tests.
- HTTP `POST /push/subscribe`. The bridge's `remoteControl.subscribePush`
  stays.
- The `/ws` upgrade path on `WsBridgeServer`: `handleUpgrade`, `BRIDGE_PATH`
  and the `ws` `WebSocketServer`. `attach(socket, auth)` is what the relay uses,
  and it stays.
- The web app's loopback pairing path: `mode: "listener"` in
  `src/bridge/web-pairing.ts`, `webSocketPipe`, `bridgeUrlFromLocation` and
  `WEB_TOKEN_KEY` in `src/bridge/transports/ws.ts`, and the listener branch of
  `src/bridge/install-web.ts`. The web app is served only by the relay origin.
- The loopback link in the pairing dialog and the listener-address line in
  settings.
- `tests/e2e/remote-control.spec.ts` and its package scripts.

**D3 — A `RelayGate` replaces the server object.** The relay needed the server
for device auth, failed-auth backoff and `closeDevice`. Those move to a small
`electron/remote-control/relay-gate.ts`, built from `DeviceStore`,
`AuthRateLimiter` (`rate-limit.ts`, now keyed only on the relay's hello) and
the bridge's set of attached connections. Two other changes:

- "Remote control is on" becomes a controller flag. It used to be
  `server.running`.
- Enabling remote control now just loads the runtime: identity, push, gate and
  bridge. Starting the relay is still a separate, confirmed action.

The e2e specs that used `http://127.0.0.1:<port>/app#<token>` (`web-app`,
`phone` and `detach`) now run through the local relay setup that
`relay.spec.ts` already uses: wrangler, `MANOR_RELAY_URL` and
`pnpm build:web:relay`.

**D4 — One tier, one road.** The changes:

- Pairing is relay-only and always `full`. `pair(label)` takes no
  `capability`/`via`, and the via toggle and tier picker are removed from the
  pairing form.
- `Capability`, `CAPABILITIES`, `canSend`, `assertCapability` and the
  `canSend` → capability migration are deleted.
- The road gate collapses to a plain verify.
- With no tier able to produce 4403, `ForbiddenScreen`, `onForbidden` and the
  4403 branches are deleted. `CLOSE_FORBIDDEN` stays reserved in
  `bridge/types.ts` and `relay-crypto/protocol.ts` so the code is never reused.
- The audit `tier` field is dropped.

**D5 — Old devices are dropped on load.** In `devices.ts` `asDevice`, any row
that is not `via: "relay"` with a `relayRoom` returns null. That covers missing
`via`, `"tailscale"`, and any non-`full` capability. `load()` then rewrites the
file, as the existing migration path does, so the rows are purged from disk.
Persisted `via` and `capability` fields go away. Older rows are read for
compatibility only.

**D6 — Docs.** Rewrite `docs/remote-control.md` for one road. Remove the
**Remote client**, **Capability** and **Remote surface** terms from
`CONTEXT.md`. Update `docs/AGENT-SYSTEM.md`, the relay's unpublished-page copy
("…or use Tailscale"), `tests/e2e/README.md` and the comments that mention the
tunnel. Add a CHANGELOG entry. Historical ADRs are not edited.

## Consequences

**Better**
- Thousands of lines and a whole external-process lifecycle go away. There is
  no spawned child to orphan, no PATH or app-bundle detection, and no Homebrew
  install.
- There is one mental model: scan a QR and the relay carries the whole bridge.
  The settings page, the status badge and the MCP status all get simpler.
- The security surface shrinks. Remote control no longer opens any listening
  socket: no static files, no HTTP route table and no `/ws`. The only way in
  is a Noise handshake through the relay, followed by the bridge.

**Harder**
- **Every remote device now depends on the relay being up.** There is no
  network-layer first factor any more (ADR-206 D8's "it is still a choice" is
  withdrawn).
- **Existing Tailscale, Watch and Reply devices stop working** and are deleted
  on upgrade. Their owners must re-pair through the relay. The CHANGELOG says so.
- **There are no read-only devices.** Every device can type into terminals.
- The lightweight, no-JS-framework client is gone. Phones load the full web app.

**Risks**
- **The web-app, phone and detach e2e specs need the local relay** (wrangler
  plus the relay web build). They become slower and gain more moving parts. In
  exchange, they test the road users actually take.
- **`ws-bridge.test.ts` ran the bridge over the real listener's `/ws`.** Its
  invoke, events and layout coverage must move onto `WsBridgeServer.attach`
  with an in-memory `FrameSocket`, not be deleted with the listener.
- **Nothing can open the web app from this machine without the relay.** That
  is acceptable: the desktop app is already open there.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
