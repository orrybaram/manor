---
title: Room, link, handlers, host server, host links, renderer types
status: todo
priority: critical
assignee: opus
blocked_by: [1]
---

# Room, link, handlers, host server, host links, renderer types

Implement ADR-240 D1 (link format) and D7, and the `reissue` method. Read `index.md` in this folder.

- `electron/remote-control/relay/url.ts`: `relayPairingUrl({ origin, appVersion, roomId, x25519Pub, credential: { ticket } | { rawToken } })` → `&ticket=` or `&t=`. `parseRelayPairingUrl` returns `{ roomId, x25519Pub, rawToken?: string, ticket?: string }`, null only when neither is present.
- `electron/remote-control/relay-room.ts`: `PairResult { device; pairingUrl; expiresAt: number | null; rawToken?: string }`; `pair(label, options?)` passes `options` to `devices.pair`; new `reissue(id)` on the serial queue (builds the URL from `relay()`; no `revokeStale`).
- `electron/remote-control/controller.ts` (:288): `pair(label, options?)`, new `reissue(id)`; both `emit()`.
- `electron/bridge/handlers/remote-control.ts`: `remoteControlPair(ctx, label, options?)` validates `options` is `undefined` or `{ direct?: boolean }`; new `remoteControlReissue(ctx, id)` (validate id string); register `reissue` with `localOnly: true` (and `mutating` like `pair`). Add it wherever `pair` is listed: `electron/bridge/local-only.ts`, `src/bridge/unavailable.ts` if it enumerates methods, `electron/bridge/routes.ts` / `electron/bridge/__tests__/routes-surface.test.ts` if they inventory methods.
- `electron/host-server/relay.ts` (:189-191, :328): `HostRemoteControl.pair(label, options?)` → `room.pair(label, options)`. Do not add `reissue` to `electron/host-server/handlers.ts`.
- `electron/bridge/handlers/hosts.ts` (:496) `hostsPairDevice`: call unchanged (ticket link by default); update its doc comment.
- `electron/remote-control/host-links.ts` (:284-365): `pair(mint.label, { direct: true })`, `token: result.rawToken`, parse the URL for room/key only; a result without `rawToken` is treated like an unparseable link (revoke what was minted, link nothing). Update `LinkedHostPairing.token` doc.
- `src/electron.d.ts` (:637, :661): `RemoteDeviceInfo.pending?: { expiresAt: number }`; `RemotePairResult { device; pairingUrl; expiresAt: number | null; rawToken?: string }`; `remoteControl.pair(label, options?)`; `remoteControl.reissue(id): Promise<RemotePairResult>`. Make the renderer API/preload expose `reissue` the same way `pair` is exposed (find how `remoteControl.pair` reaches `window.electronAPI` / the bridge client and mirror it).

## Files to touch
- Source: the files above.
- Tests: `electron/remote-control/__tests__/relay-room.test.ts` (fake `devices.pair` shape; link assertion becomes `&ticket=`; add `reissue` and `direct` cases), `electron/remote-control/__tests__/controller.test.ts` (fake shapes; `reissue` emits), `electron/remote-control/__tests__/host-links.test.ts` (fake host `pair` asserts `{ direct: true }` and returns `rawToken` + `t=` URL; add "a host answering a ticket link links nothing"), `electron/bridge/__tests__/integrations-crossing.test.ts`, `electron/bridge/__tests__/caller-class.test.ts`, `electron/bridge/handlers/__tests__/hosts.test.ts` (fake `pair` shapes), `electron/host-server/__tests__/harness.ts` (`parsePairingUrl` :157 reads `&t=` or `&ticket=`; `phone(pairingUrl, opts?)` generates a 32-byte base64url token for a ticket link, sends `{type:"hello", ticket, token}` and exposes the token so callers can redial), `electron/host-server/__tests__/relay-room.test.ts` (add: a link is redeemed once — a second phone on it is refused 4401, the first redials with its token; `pair(label, {direct:true})` gives the owner a raw token that works on hello). Note: the gate's redeem lands in ticket 3; host-server end-to-end tests that hello with a ticket need ticket 3 — if you run before it, make the harness tolerate both and leave the redeem-once test for after ticket 3 is merged (ticket 3 runs in parallel; coordinate by keeping your changes to `relay-gate.ts` at zero).

Acceptance: `pnpm typecheck`, `pnpm vitest run electron`.
