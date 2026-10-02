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

**D2 — Delete the remote client and the listener's HTTP surface.** Delete:

- `src/remote-client/` and `vite.remote.config.ts`. Its icons move to
  `src/web/public/icons`, because `vite.web.config.ts` borrows them;
- `static.ts`'s client half, `sse.ts`, `listener-routes.ts` and `allowlist.ts`;
- `guardWrites` and the allowlisted route table in `server.ts`;
- HTTP `POST /push/subscribe`. The bridge `remoteControl.subscribePush` stays;
- `tests/e2e/remote-control.spec.ts` and its package scripts.

**D3 — Keep a slim loopback listener.** `RemoteControlServer` still binds
`127.0.0.1:0`. It serves only the web app (`/app`, `/app/*`) and the bridge
upgrade (`/ws`). It also still owns device auth, the auth rate limiter and
`closeDevice`, which the relay hello uses. This keeps two things working:

- the "this machine" link in the pairing dialog;
- the e2e specs that open `http://127.0.0.1:<port>/app#<token>` (`web-app`,
  `phone`, `detach`).

Nothing is reachable from off the machine except through the relay.

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
- The security surface shrinks. There is no unauthenticated static client and no
  HTTP route table for paired devices. The only paired-device surface is the
  bridge.

**Harder**
- **Every remote device now depends on the relay being up.** There is no
  network-layer first factor any more (ADR-206 D8's "it is still a choice" is
  withdrawn).
- **Existing Tailscale, Watch and Reply devices stop working** and are deleted
  on upgrade. Their owners must re-pair through the relay. The CHANGELOG says so.
- **There are no read-only devices.** Every device can type into terminals.
- The lightweight, no-JS-framework client is gone. Phones load the full web app.

**Risks**
- E2E pairing now needs a relay origin to build a pairing URL. The helpers set a
  dummy `MANOR_RELAY_URL` and use the loopback `/app` link. Relay tokens are
  already admitted on loopback, so no relay process is needed for those specs.
- The `server.test.ts` and `ws-bridge.test.ts` suites shrink a lot. Bridge
  coverage (invoke, events, layout) must be kept, not deleted with the HTTP
  tests.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
