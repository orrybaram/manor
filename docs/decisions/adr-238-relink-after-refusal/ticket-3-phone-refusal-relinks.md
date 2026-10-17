---
title: "Phone: a refusal only drops the pairing, relinks once; Hosts sheet copy"
status: review
priority: high
assignee: sonnet
blocked_by: [1]
---

# Phone: a refusal only drops the pairing, relinks once; Hosts sheet copy

Implements ADR-238 D1 and D4.

- `src/bridge/web-pairing.ts`: `forgetPairing` calls `removePairing` (not `declinePairing`); fix imports. Doc: "The room is not declined: the desktop mints it again on its next hello unless that device was revoked on the host, which the desktop remembers (ADR-238)."
- `src/bridge/pairings.ts`:
  - The `DECLINED_KEY` doc now covers removal by hand only.
  - `declinePairing` checks that the exact pairing exists, writes the declined list, and then calls `removePairing` (which notifies). Subscribers must see the room declined already.
  - `undeclineRoom` calls `notify()` when it changes something.
  - `declinedRooms()` returns a cached snapshot (same array until the raw storage string changes), like `listPairings()`.
  - Drop "or refused once by its host" from the `connectRoomDirectly` doc.
- `src/bridge/install-web.ts`:
  - Add a header doc bullet for 4401.
  - Hoist the function passed to `registerRelink` into a named `async function relinkAll()`, and register it with `registerRelink(relinkAll)`.
  - Add `const autoRelinked = new Set<string>()`. In `refuse()` (~378), after `forgetPairing` and `drop(roomId)` on a 4401: if `!autoRelinked.has(roomId)`, add it and `void relinkAll()`, catching and logging any error.
- `src/components/phone/HostsSheet/HostsSheet.tsx`:
  - Read `declined` with `useSyncExternalStore(subscribePairings, declinedRooms, declinedRooms)`.
  - `IndirectHostRow` takes `declined: boolean` (`host.roomId` is in the declined list).
  - Declined: status "Removed here · only through <desktop>" plus the **Connect directly** button.
  - Not declined: "Only through <desktop>" (or "· no relay") and no button.
  - Update the component docs.

## Tests
- `src/bridge/__tests__/web-pairing.test.ts`: the `forgetPairing` cases assert `declinedRooms()` stays `[]`.
- `src/bridge/__tests__/pairings.test.ts`:
  - `declinedRooms()` returns the same array until it changes
  - a subscriber notified by `declinePairing` already sees the room declined
  - `connectRoomDirectly` on a declined room notifies
- `src/bridge/__tests__/install-web-relay.test.ts`:
  - "forgets only the pairing refused with 4401" (~478): `declinedRooms()` is `[]`, and after the close the desktop socket gets another `linkHostPairings` frame. Make sure the desktop entry is `kind: desktop`.
  - new: a second 4401 on the same room in the same load sends no further ask
  - "sends rooms the user removed as held" stays unchanged
- `src/components/phone/HostsSheet/__tests__/HostsSheet.test.ts`:
  - the "Connect directly" case first declines the room, and expects "Removed here · only through …"
  - new: an indirect host that isn't declined reads "Only through …" and has no `phone-host-connect-directly` button

## Files to touch
- `src/bridge/web-pairing.ts`
- `src/bridge/pairings.ts`
- `src/bridge/install-web.ts`
- `src/components/phone/HostsSheet/HostsSheet.tsx`
- `src/bridge/__tests__/web-pairing.test.ts`
- `src/bridge/__tests__/pairings.test.ts`
- `src/bridge/__tests__/install-web-relay.test.ts`
- `src/components/phone/HostsSheet/__tests__/HostsSheet.test.ts`

Acceptance: `pnpm typecheck` and `pnpm test:unit` pass.
