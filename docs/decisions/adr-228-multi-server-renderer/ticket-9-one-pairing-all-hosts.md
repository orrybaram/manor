---
title: One pairing covers every host (linkHostPairings)
status: todo
priority: high
assignee: opus
blocked_by: [7]
---

# One pairing covers every host (linkHostPairings)

ADR-228 D9.

## Do
- **Desktop method `remoteControl.linkHostPairings(heldRooms: string[])`.**
  - It is device-callable and `mutating`.
  - It has no `localOnly`. Explain why in the handler doc, citing ADR-228 D9.
  - For each host whose server is connected, whose `roomId` is not in
    `heldRooms`, and whose "Phones paired with this Mac can reach \<host\>"
    switch is on:
    - call `client.api.remoteControl.pair(deviceLabel)` over the owner channel;
    - record `{hostId, hostDeviceId}` against the calling device in
      `RemoteDeviceStore` (`electron/remote-control/`);
    - return `{roomId, serverKey, token, name}`.
  - A `local` caller gets an empty list.
- **Revoke cascade.**
  - `remoteControl.revoke(deviceId)` on the desktop also calls
    `hosts.revokeDevice` for each linked pairing.
  - A host that is away gets a pending revoke, stored and retried on its
    next owner connect (`electron/backend/host-server-sync.ts`).
  - Turning the per-host switch off revokes every linked pairing on that
    host.
- **Settings.** `HostPhoneAccess.tsx` gets the "Phones paired with this Mac
  can reach \<host\>" switch, on by default, persisted on `PersistedHost`.
  The device list marks linked pairings ("via This Mac").
- **Phone.**
  - On every hello from a server with `hostServer: false`, call
    `linkHostPairings(listPairings().map(p => p.roomId))`.
  - `upsertPairing` each result and add it to the server set.
- **Tests:**
  - minting skips held rooms;
  - revoking cascades, including a pending revoke for an away host;
  - the switch off revokes;
  - the E2E pairs a phone with the desktop only and then reaches the host
    with the desktop stopped.

## Files to touch
- `electron/bridge/handlers/remote-control.ts`,
  `electron/bridge/handlers/hosts.ts`
- `electron/remote-control/` device store, `electron/backend/host-server-sync.ts`
- `electron/backend/persistence` for `PersistedHost`
- `src/components/settings/HostPhoneAccess.tsx`, `src/store/host-store.ts`
- `src/bridge/install-web.ts` (call on hello)
- tests and the phone E2E
