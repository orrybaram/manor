---
title: One tier, one road — relay-only full pairing; drop old devices on load
status: todo
priority: high
assignee: opus
blocked_by: [2]
---

# One tier, one road — relay-only full pairing; drop old devices on load

ADR-207 D4 and D5.

## Devices (`electron/remote-control/devices.ts`)

- Delete `Capability`, `CAPABILITIES`, `isCapability`, `canSend`, `PairedVia`,
  `isPairedVia`, `asCapability`, the `canSend` migration and `idsVia`.
  - `resetRelayAddress` then revokes all devices.
- `pair(label, relayRoom)`: every device is a relay device. `relayRoom` is
  required.
- `asDevice` returns **null** for any row that does not have both
  `via === "relay"` and a string `relayRoom`. That covers missing `via`,
  `"tailscale"`, and old `read`/`send` capability rows.
  - Relay rows were always `full`, so any row with a capability other than
    `full` is also dropped.
  - `load()` must mark `migrated` when it dropped a row, so the file is
    rewritten without them.
- The persisted shape no longer has `via` or `capability`.
  - Remove them from `KNOWN_FIELDS` handling, so old rows that carry them still
    parse.
  - Keep `relayRoom`.
- Fix the `extra` comment, which used the via downgrade as its rationale.

## Server and bridge

- `relay-gate.ts` (created by ticket 2): drop the road (`via`) check and the
  4403 tier check. Authentication becomes a plain verify plus backoff.
  - Drop `AuthenticatedDevice.via`.
  - Update `electron/bridge/transports/ws.ts` docs.
- `electron/bridge/handlers/remote-control.ts`:
  - `pair` takes only `label`.
  - Delete `assertCapability`.
- `controller.ts`:
  - `pair(label)` is the old `pairViaRelay` minus the capability check.
  - Delete `pageFor` and `PairResult.page`.
- `audit.ts`: drop the `tier` field. Update its writer at
  `electron/bridge/server.ts:527`.
- 4403 is now unreachable:
  - Delete `ForbiddenScreen` (`src/web/screens.tsx`), its use in
    `src/web-main.tsx` and the `"forbidden"` outcome in
    `src/bridge/install-web.ts`.
  - Delete `onForbidden`, `defaultForbidden` and the 4403 branch in
    `src/bridge/transports/ws.ts`, and their tests (`ws.test.ts:511-514`).
  - Keep `CLOSE_FORBIDDEN` defined in `electron/bridge/types.ts` and
    `src/lib/relay-crypto/protocol.ts`, with a "reserved, not sent" comment.
- `relay/__tests__/connector.test.ts`: delete the 4403 test and the send-tier
  fixture.

## Renderer

- `src/electron.d.ts`: delete `RemoteCapability` and the device `capability`
  and `via` fields.
- `remote-control-store.ts`: `pair(label)`.
- `RemoteControlPage.tsx`:
  - Delete `Via`, `VIA_OPTIONS`, `VIA_LABEL`, `RELAY_PAIR_WARNING` (fold any
    still-relevant copy into the pairing form), `CAPABILITY_OPTIONS`,
    `CAPABILITY_HINT` and `CAPABILITY_BADGE`, the via `ToggleGroup`, the
    capability picker, `capabilityCounts`, and the via and capability badges on
    `DeviceRow`.
  - The pair form is now just a name and a button. It is enabled when the relay
    origin is configured. Otherwise it shows why.
- `RemoteControlDialogs.tsx`: delete `capabilitySentence`. `RelayConfirmDialog`
  copy states that paired devices can do everything.
- CSS: delete `.remoteCapabilityRow`. Keep `.remoteSendBadge` if the push badge
  still uses it.

## Tests

- Update to the new signatures and drop tier and via cases:
  - `devices.test.ts`. The no-via test becomes "drops it". Add tests: a
    `"tailscale"` row is dropped and the file is rewritten; a `read` row is
    dropped.
  - `push.test.ts`
  - `controller.test.ts`
  - `relay-gate.test.ts`
  - `ws-bridge.test.ts`
  - `integrations-crossing.test.ts`

## E2E — move the loopback specs to the local relay

The loopback listener is gone (ticket 2), so `web-app.spec.ts`,
`phone.spec.ts` and `detach.spec.ts` can no longer open
`http://127.0.0.1:<port>/app#token`. Move them onto the local relay setup
`tests/e2e/relay.spec.ts` already uses:

- wrangler dev relay;
- `MANOR_RELAY_URL`;
- the `dist-relay-web/` build from `pnpm build:web:relay`;
- start the relay, pair, open the pairing URL.

Read `relay.spec.ts` and its helpers first.

- Factor the relay start/stop and launch-with-relay code out of
  `relay.spec.ts` into a shared helper or fixture. Do not copy it into each
  spec.
- `tests/e2e/helpers/settings.ts`:
  - `enableRemoteControl` no longer returns a port.
  - `pairDevice` pairs through the relay form, with no radio and no capability.
    It returns the pairing URL. It can merge with `pairDeviceViaRelay`.
  - Delete `PairedCapability` and `CAPABILITY_BUTTON`.
- `tests/e2e/helpers/phone.ts`: `openWebApp` opens the relay pairing URL.
- Delete `web-app.spec.ts` "a send device cannot open the full web app".
- Update every call site in `web-app.spec.ts`, `phone.spec.ts` and
  `detach.spec.ts`.
- Make sure the e2e entry points build what the relay specs need. If
  `relay.spec.ts` relies on a manual `pnpm build:web:relay`, put that step
  where the e2e scripts or `tests/e2e/README.md` will run it for these specs
  too.
- **Do NOT run Playwright yourself.** It runs past agent watchdogs. Make sure
  it typechecks; the orchestrator runs the e2e suite.

## Files to touch
- `electron/remote-control/devices.ts`, `relay-gate.ts`, `controller.ts`, `audit.ts`, `relay/connector.ts`
- `tests/e2e/relay.spec.ts` and a new shared relay e2e helper/fixture
- `electron/bridge/handlers/remote-control.ts`, `electron/bridge/server.ts`, `electron/bridge/transports/ws.ts`, `electron/bridge/types.ts`
- `src/electron.d.ts`, `src/store/remote-control-store.ts`
- `src/components/settings/RemoteControlPage.tsx`, `RemoteControlDialogs.tsx`, `SettingsModal/SettingsModal.module.css`
- `src/web/screens.tsx`, `src/web-main.tsx`, `src/bridge/install-web.ts`, `src/bridge/transports/ws.ts`, `src/lib/relay-crypto/protocol.ts`
- tests under `electron/remote-control/__tests__/`, `electron/remote-control/relay/__tests__/`, `electron/bridge/__tests__/`, `src/bridge/__tests__/`
- `tests/e2e/helpers/settings.ts`, `tests/e2e/web-app.spec.ts`, `phone.spec.ts`, `detach.spec.ts` and the e2e launch helper
