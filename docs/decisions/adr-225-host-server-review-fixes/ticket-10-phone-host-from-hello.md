---
title: Phone learns host-server status from the hello; one pairing credential shape
status: todo
priority: critical
assignee: opus
blocked_by: [9]
---

# Phone learns host-server status from the hello; one pairing credential shape

## Problems (verified by review)

- `src/bridge/host-restrictions.ts:20-56` restricted flag set only by `client.ts:167` on the first `unavailable:host` reply. First attempt still errors. Hello already carries `hostName` (`install-web.ts:140`; host `server.ts` always sends it; desktop never does).
- Hand gates: `ProjectItem.tsx:422-424` (+3), `ProjectGroupItem.tsx:93-95` (+2), `PhoneEmptyWorkspace.tsx:28-29`, two `requestNewWorkspace` wrappers. Missed: `App.tsx:355`, `App.tsx:602` (`openNewWorkspace`), `commands.ts` `new-workspace` (~440) and `new-agent` (~432). `unlessHostRestricted` writes its own toast instead of `src/lib/bridge-unavailable-toast.ts` `showBridgeUnavailableToastOnce`.
- `web-pairing.ts` `RelayCredentials {roomId, serverKey, token}` vs `pairings.ts` `StoredPairing {roomId, x25519Pub, token, …}`: two validators, `toCredentials`, reverse mapping in `readPairing` (136-140), remap in `legacyPairing`, `serverKeyBytes` wrapper. `forgetPairing` checks key then `removePairing(roomId, token)` checks token again.
- `listPairings()` is `useSyncExternalStore` getSnapshot (`PhoneHostSwitcher.tsx:32`) but writes localStorage + `notify()` during migration.
- `setActiveRoom`/`getActiveRoom` in `pairings.ts` duplicates `webRoomId` from `install-web.ts:72`; module header says "Pure storage, no bridge". Three connection singletons.
- `src/bridge/transports/ws.ts:293-296` needless double casts on `hostName`; `BridgeUnavailableError.code` widened to `string` (`client.ts:127-137`).

## Do

1. New `src/bridge/connection.ts`: hello facts (active room, host name, `isHostServer`), written by `install-web.ts` `onHello`, read by components (subscribe-able for React). Absorbs `host-restrictions.ts` (delete it or reduce to a selector) and `setActiveRoom`/`getActiveRoom`. `isHostServer` is true when the hello has `hostName`. Remove `markHostRestricted` from `client.ts` settle.
2. Gate once: `NewWorkspaceDialog` renders the named "not available on <host> yet" state when `isHostServer`; command availability gains a host-server flag next to `commandAvailableOnWeb` covering `new-workspace` and `new-agent`. Delete the per-callsite checks in `ProjectItem.tsx`, `ProjectGroupItem.tsx`, `PhoneEmptyWorkspace.tsx` (keep the named empty state if it is display, not a gate) and both `requestNewWorkspace` wrappers. Any toast uses `showBridgeUnavailableToastOnce`. Composer disabling reads `isHostServer` too (find where restricted is read: grep `useHostRestricted`/`isHostRestricted`).
3. `interface StoredPairing extends RelayCredentials { name; addedAt; lastUsedAt }`; `isStoredPairing` reuses `isRelayCredentials`. Legacy migration → `{...legacy, name: "Host 1", addedAt, lastUsedAt}`. `readPairing` returns `upsertPairing(fresh.relay)`. Delete `toCredentials`, mappings, `serverKeyBytes`. `removePairing` takes credentials and matches all three fields; `forgetPairing` just calls it.
4. Legacy migration runs once in `readPairing()` at boot; `listPairings` only reads (cached snapshot so `useSyncExternalStore` gets a stable reference).
5. `ws.ts`: `typeof reply.hostName === "string" ? reply.hostName : null`. Type `UnavailableCode = "unavailable:web" | "unavailable:host"`; `isUnavailableCode(code): code is UnavailableCode` in `electron/bridge/types.ts`; `BridgeUnavailableError.code: UnavailableCode`.
6. Update tests: `src/bridge/__tests__/host-restrictions.test.ts` (→ connection test), `pairings.test.ts`, `web-pairing.test.ts`, `install-web-relay.test.ts`, `PhoneEmptyWorkspace.test.ts`, `PhoneHostSwitcher.test.ts`, command tests.

## Files to touch
- `src/bridge/connection.ts` (new), `host-restrictions.ts`, `pairings.ts`, `web-pairing.ts`, `install-web.ts`, `client.ts`, `transports/ws.ts`, `unavailable.ts`
- `electron/bridge/types.ts`
- `src/components/sidebar/ProjectItem.tsx`, `ProjectGroupItem.tsx`, `src/components/phone/PhoneEmptyWorkspace.tsx`, `PhoneHostSwitcher.tsx`
- `NewWorkspaceDialog` (find it), `src/App.tsx`, `commands.ts` (find it), `src/lib/bridge-unavailable-toast.ts`
- related tests
