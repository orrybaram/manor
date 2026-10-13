---
title: HostPhoneAccess on a store slice with one status call and a pairingChanged event
status: done
priority: medium
assignee: sonnet
blocked_by: [10]
---

# HostPhoneAccess on a store slice with one status call and a pairingChanged event

## Problems (verified by review)

- `src/components/settings/HostPhoneAccess.tsx:34-58,113-121,139-144,180-189`: 7 `useState`s; reloads on `hosts.serverChanged` broadcast AND calls `await load()` after pair/reset → double fetch, out-of-order responses can leave stale data. Revoke does `setDevices(result)` but `view.status.devices` (count) stays stale → "2 phones paired" with 1 row. Count and list loaded with two calls (`serverStatus` then `listDevices`).
- `electron/bridge/handlers/hosts.ts:115-124` `pairingChanged` reuses `hosts.serverChanged` with an unchanged state to mean "pairing changed".
- Inline reset-keys confirm doesn't match desktop `ResetRelayDialog`.
- `src/components/phone/Phone.module.css` `.hostMenu`, `.hostSelect` are byte copies of `.overflowMenu`/`.overflowItem` (~175-200) except `min-width`/`flex`.

## Do

1. `hosts.serverStatus` returns `{ state, status, devices }` in one call (devices list; drop the `devices: number` count or derive it). Delete `hosts.listDevices` if nothing else uses it. Keep ElectronAPI/HANDLERS surface consistent (build enforces ADR-180 D7: every `ElectronAPI` method placed in HANDLERS / nativeApi / LOCALLY_SERVED / SUBSCRIPTIONS) — update `src/electron.d.ts`, preload, surface lists.
2. New event `hosts.pairingChanged` (hostId) emitted by the mutating handlers (via `hostServerSync.pairingChanged` from ticket 9); `hosts.serverChanged` only for real state changes.
3. Store slice (e.g. in the existing remote-control store, `useRemoteControlStore`, or a sibling `useHostServersStore`): `hostServers: Record<hostId, HostServerView>`, subscribes once to both events, takes only the newest response per host (request counter). `HostPhoneAccess` reads it; mutations just await and let the event refresh. Remove the 7 useStates.
4. Generalise `ResetRelayDialog` copy (host name param) and use it for the host reset confirm.
5. CSS: extract shared `.phoneMenu`/`.phoneMenuItem` (or compose) for overflow menu and host switcher.

## Files to touch
- `electron/bridge/handlers/hosts.ts`, `__tests__/hosts.test.ts`, `electron/bridge/events.ts`, `electron/backend/host-server-sync.ts`
- `src/electron.d.ts`, preload / surface lists as required by the build
- `src/components/settings/HostPhoneAccess.tsx`, `RemoteControlDialogs.tsx` (ResetRelayDialog), `RemoteControlPage.tsx`, the store file
- `src/components/phone/Phone.module.css`, `PhoneHostSwitcher.tsx`, phone overflow menu component

## Added from ticket 10

6. `src/bridge/client.ts` `settle` is now a one-line pass-through to `settleResult` (`electron/bridge/settle.ts`). Have `src/bridge/transports/ipc.ts` / `ws.ts` (and any other caller) import `settleResult` directly and delete the wrapper.
