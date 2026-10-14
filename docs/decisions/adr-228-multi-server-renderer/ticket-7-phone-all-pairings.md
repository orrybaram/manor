---
title: The phone connects to every pairing at once
status: todo
priority: critical
assignee: opus
blocked_by: [4, 2]
---

# The phone connects to every pairing at once

ADR-228 D2 (phone ids), D3, D6 (phone last-known) and D8.

## Do
- **`install-web.ts`** opens one relay bridge per stored pairing.
  - Each one is `relayPipe` + `createWsTransport`, as today, and becomes a
    server-set entry whose id is the room id.
  - The home server is the paired desktop (hello `hostServer: false`), or
    else the most recently used pairing.
  - 4401 forgets only that pairing, and removes its entry.
  - The version-redirect logic in `onHello` applies to the home server only.
    A host on another version stays in the set; record its version.
- **Renderer host ids (D2).**
  - The router stamps a server's own `local` as its room id.
  - Remote hosts listed by a desktop are mapped through that desktop's
    `hosts.list` `roomId` (ticket 2). An unmapped one becomes
    `<desktopRoom>/<hostId>`.
- **Source rule (D3).** A host with a direct pairing is sourced from it
  while reachable, and otherwise from the desktop.
- **Last-known (D6).** Persist each server's last merged answers in
  IndexedDB, keyed by room, and serve them while it is unreachable. Wrap
  every read and write in try/catch, because storage may be unavailable.
- **UI.**
  - Delete `PhoneHostSwitcher` and its reload, and remove it from
    `PhoneTopBar`.
  - Add a **Hosts** sheet to the phone menu (`src/components/phone/`).
  - The sheet lists pairings with name and reachability, renames a pairing
    (`renamePairing`), and removes a pairing with an in-place confirm. Keep
    the `phone-host-*` testids where they map.
  - Use `src/components/ui/` components.
- **Commands and the new-agent target picker** (ADR-222) list workspaces
  from the merged stores. Check that a launch goes to the workspace's
  source.
- **E2E** (phone suite):
  - a phone paired with the desktop and a host server sees both hosts'
    projects in one sidebar;
  - with the desktop stopped, the host's projects stay live;
  - removing a pairing drops its projects.

## Files to touch
- `src/bridge/install-web.ts`, `src/bridge/web-pairing.ts`,
  `src/bridge/pairings.ts`
- `src/bridge/router.ts` (phone id stamping), `src/bridge/last-known.ts` (new)
- `src/components/phone/PhoneHostSwitcher.tsx` (delete),
  `src/components/phone/PhoneTopBar.tsx`,
  `src/components/phone/HostsSheet/` (new)
- `e2e/` phone specs

## Carried over from ticket 4 (commit 23bb1943)
- **API.** Add a pairing with
  `servers.add(roomId, createWsTransport({ token, pipe, ...servers.hooks(roomId) }), { roomId, lists })`.
  Change what a server lists later with `servers.setLists(id, …)`.
- **The phone's home id is still `local`**, and all rewriting is skipped for
  an entry whose id is `local`. Switch to room ids here (D2). The single hook
  point for remapping ids is `stampResult`/`stampKey` in
  `src/bridge/router.ts`.
- **`lists` for a desktop** comes from its `hosts.list` (`roomId` per host,
  from ticket 2).
- **Last-known answers** live in the router's in-memory `lastKnown` map.
  Persist them to IndexedDB per room here.
- `useConnection()` and `connection.ts` read the home entry, with
  TODO(ADR-228) markers. Resolve those that mean "this host".
