---
title: "Desktop: host blocks in the device store and HostPairingLinks"
status: done
priority: critical
assignee: opus
blocked_by: []
---

# Desktop: host blocks in the device store and HostPairingLinks

Implements ADR-238 D2. Read the ADR's Decision first.

## devices.ts
- `HostLink.roomId?: string`: the host's room the pairing was minted in. Absent on a link from before ADR-238.
- `RemoteDevice.hostBlocks?: string[]`: hosts (desktop host ids) where this device's linked pairing was revoked on the host. Nothing is minted there until the host's switch is turned off and on.
- `asHostLinks` reads an optional string `roomId`. New `asHostBlocks` keeps unique non-empty strings and returns `[]` for anything malformed. Add `"hostBlocks"` to `KNOWN_FIELDS`. Add `"hostBlocks"` to the `Omit` in `RemoteDeviceInfo`, and strip it in `publicView`. `asDevice` spreads `hostBlocks` only when non-empty.
- New methods:
  - `hostBlocks(id): readonly string[]`
  - `blockHost(id, hostId): Promise<boolean>`: adds the block (no duplicates), drops the device's link on that host, persists and flushes like `setHostLink`. Returns false when the device isn't paired.
  - `blockedOn(hostId): Array<{ deviceId: string; label: string }>`
  - `clearHostBlocks(hostId): Promise<void>`: removes the host from every device, deleting the field once it's empty. Persists only if something changed.
- `setHostLink` stores `roomId` when given. Update the module doc.

## host-links.ts
- Header doc: add bullets "A revoke on the host" and "The switch back on".
- `HostPairingLinksOptions.devices` Pick adds `"hostBlocks" | "blockHost" | "blockedOn" | "clearHostBlocks"`. `HostLinkRecords` adds `pendingRevokes(hostId): readonly string[]`.
- `linkOne`: after the switch, room and relay checks, return null if `devices.hostBlocks(deviceId).includes(hostId)`. For the device's stale links on this host, call a new private `settle(client, hostId, roomId, links)` before owing revokes:
  - It calls `listDevices()` once. For each link:
    - **listed**: return it in `present`. The caller owes it a revoke as today, then mints.
    - **absent, and `link.roomId` is set and differs from the status room**: the host was reset elsewhere. `devices.dropHostLinks(hostId, deviceId)`, and the mint goes on.
    - **absent otherwise** (same room, or no `roomId`): revoked on the host. `devices.blockHost(deviceId, hostId)`, warn, and `linkOne` returns null without minting.
  - If `listDevices` throws, let it propagate; `link` already logs and skips that host.
  - It returns `{ present: string[]; changed: boolean; blocked: boolean }` (shape is your call).
- `setHostLink(deviceId, { hostId, hostDeviceId: result.device.id, roomId })`.
- Public, run through `this.serially`:
  - `reconcileLinks(hostId)`: skip unless `devices.ready` and the client is connected. Read status → room (null → return). Take `devices.linksOn(hostId)` minus `records.pendingRevokes(hostId)`, run `settle`, and call `pairingChanged(hostId)` if anything was blocked or dropped.
  - `revokeOnHost<T>(hostId, hostDeviceId, revoke: () => Promise<T>): Promise<T>`: runs `revoke`, then blocks the device whose link on `hostId` has that `hostDeviceId`, if any.
- `blockedOn(hostId)` passes through to the device store.
- `setLinkPhones(hostId, true)` → `devices.clearHostBlocks(hostId)`. `resetHost` stays unchanged; its doc says blocks survive a reset.

## host-server-sync.ts
- New option `reconcileLinks?: (hostId: string) => Promise<void>`, awaited in `sendAll` after `revokePending`, wrapped in try/catch with a warn. Add a header doc bullet "Revokes made on the host (ADR-238)".

## app-lifecycle.ts
- Wire `records.pendingRevokes` (near ~307) to the project manager's pending host revokes (find the existing accessor, e.g. `pendingHostRevokes`; add one if missing, in `electron/projects/project-manager.ts` / `host-records.ts`).
- Wire `reconcileLinks: (hostId) => hostLinks.reconcileLinks(hostId)` into HostServerSync (~333).

## Tests
- `electron/remote-control/__tests__/devices.test.ts`:
  - `blockHost` drops the link and survives a restart
  - `clearHostBlocks` works
  - `list()` never exposes `hostBlocks`
  - a link's `roomId` round-trips
  - malformed `hostBlocks` is dropped silently
- `electron/remote-control/__tests__/host-links.test.ts`: the fake records gain `pendingRevokes`, and the sync options gain `reconcileLinks`. Cases:
  - (a) `revokeOnHost` blocks the phone on box: `link` mints nothing there but still mints on the other host; no box link remains; `blockedOn("box")` names the phone
  - (b) switch off then on clears the block, and the next `link` mints
  - (c) `resetHost` keeps the block
  - (d) external revoke (device removed from the fake host's paired list) → `link` consults `listDevices`, blocks, and doesn't call `pair`
  - (e) external reset (paired list cleared, room changed) → re-minted in the new room, no block
  - (f) reconnect after an external revoke → `reconcileLinks` blocks, drops the link, and calls `pairingChanged`; after an external reset → drops the link, no block
  - (g) a legacy link with no `roomId`, absent from the host → blocked
  - (h) the existing "revokes a link the device let go of before minting it a new one" still passes

## Files to touch
- `electron/remote-control/devices.ts`
- `electron/remote-control/host-links.ts`
- `electron/backend/host-server-sync.ts`
- `electron/app-lifecycle.ts`
- `electron/projects/project-manager.ts` / `electron/projects/host-records.ts`, only if a pending-revokes accessor is missing
- `electron/remote-control/__tests__/devices.test.ts`
- `electron/remote-control/__tests__/host-links.test.ts`

Acceptance: `pnpm typecheck` and `pnpm test:unit` pass.
