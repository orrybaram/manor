---
title: Host pairing links survive a reset or a lost mint answer
status: done
priority: medium
assignee: opus
blocked_by: [1]
---

# Host pairing links survive a reset or a lost mint answer

ADR-230 D11 (gap R7). The two windows are (a) a reset landing after `pair`,
and (b) the owner channel dropping after the host committed `pair`.

## What to build

- **Serialize.**
  - `HostPairingLinks` (`electron/remote-control/host-links.ts`) gains
    `resetHost(hostId, reset: () => Promise<void>)` on its `serially`
    queue.
  - After the reset it runs `devices.dropHostLinks(hostId)` (add it if it
    doesn't exist) and clears that host's pending revokes, because the
    reset revoked every host device.
  - `hostsResetPairingKeys` (`electron/bridge/handlers/hosts.ts:415-422`)
    goes through it.
- **Room check.** In `linkOne` (:140-183), after `pair`, compare
  `parseRelayPairingUrl(result.pairingUrl).roomId` with the `roomId` from
  the `status()` call before it. If they differ:
  - queue the minted device as a pending revoke;
  - don't call `setHostLink`;
  - return null.
- **A pending mint (window b).**
  - Mint labels gain a short random suffix, so they can't collide with a
    pairing the user made on the host.
  - Before `pair`, persist `pendingMint { label, startedAt }` on the host
    record, next to `pendingRevokes` (`PersistedHost`). Clear it after a
    link is recorded or the mint is queued for revoke.
  - On the next owner connect (`HostServerSync.sendAll`,
    `electron/backend/host-server-sync.ts:274-283`), if a pending mint
    exists:
    - call the host's `remoteControl.listDevices`
      (`electron/host-server/handlers.ts:600`);
    - revoke every device whose label equals the mint's label, and whose
      `createdAt` is at or after `startedAt` (when present), and that no
      desktop link points to;
    - clear the pending mint.
  - If `listDevices` lacks `createdAt`, add it as an additive field from the
    device store. On an older host, match on label alone.

## Tests (each must fail on the base commit)

In `electron/remote-control/__tests__/host-links.test.ts` (with `fakeHost`
at :30):
- `pair` adds the device and then rejects. After the next connect's
  reconcile, the device is revoked and no link exists.
- `roomId` changes between `status` and `pair`. No link is recorded, the
  device is queued for revoke, and the next `link` mints again.
- A reset queued while a mint is running runs after it. Afterwards the host
  has no links and no pending revokes.
- A user's own pairing with a similar label is never revoked.

## Files to touch
- `electron/remote-control/host-links.ts`
- `electron/bridge/handlers/hosts.ts`
- `electron/backend/host-server-sync.ts`
- The persisted host record type and the device store: `dropHostLinks`, and
  `createdAt` in `listDevices` if missing
- `electron/host-server/handlers.ts`, if `createdAt` must be added
- Tests named above.
