---
type: adr
status: accepted
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

# ADR-238: Relink a host after it refuses the phone

## Context

When a host server refuses a phone's token (relay close 4401), the phone drops that pairing **and** remembers the room as declined (`forgetPairing` → `declinePairing`, `manor.web.declinedRooms`). Every hello with a desktop then sends that room to `remoteControl.linkHostPairings` as held, so the desktop never mints the phone a new pairing there. The host is reachable only through the desktop and goes dark when the laptop sleeps. Commit 3acdc87f added a "Connect directly" button to the phone's Hosts sheet as a manual way out. The user asked why they have to press it: it should just connect.

The decline came from ADR-228 D9: if the phone's linked pairing was revoked on the host (a "via This Mac" row), re-minting on the next hello would undo the revoke, and the phone cannot tell a revoke from a key reset, a key move or a lost device file. Since then:

- ADR-233 removed the per-host device list and the "via This Mac" rows from Settings. `hosts.revokeDevice` remains as an API (MCP/CLI) but nothing in the UI calls it, and the host's own `remoteControl.revoke` is local-only. A revoke of a linked pairing now comes from the desktop's own cascade or switch (which already drop the link), that API, a caller on the box, or a wiped device file.
- So the decline mostly catches the harmless cases (a reset, a moved key, a lost file), which is what the user hit.
- A reset changes the host's room; a revoke does not. `linkOne` already compares rooms (ADR-230 D11), so recording the room a link was minted in lets the desktop tell the two apart.

## Decision

### D1. A refusal only drops the pairing, and the page asks again once (phone)

- `forgetPairing` (`src/bridge/web-pairing.ts`) calls `removePairing`, not `declinePairing`. Only **Remove** in the Hosts sheet declines a room.
- `refuse()` in `src/bridge/install-web.ts`: after a 4401 drops a pairing, the page calls `relinkAll` (what `registerRelink` registers), at most once per room per page load (`autoRelinked: Set<string>`). A host that was reset or moved gets a fresh pairing in the same session. One revoked on the host is blocked by the desktop (D2) and stays "Only through <desktop>". With no desktop connected yet, the desktop's hello (`linkHosts`) covers it, since the dead room is no longer held.
- `declinePairing` writes the declined list before `removePairing` notifies; `undeclineRoom` notifies; `declinedRooms()` returns a cached snapshot so `useSyncExternalStore` can read it.

### D2. The desktop remembers a revoke on the host as a per-(device, host) block

Stored on `RemoteDevice` (`electron/remote-control/devices.ts`): `HostLink.roomId?` (the room the pairing was minted in) and `RemoteDevice.hostBlocks?: string[]` (host ids). New store methods: `hostBlocks(id)`, `blockHost(id, hostId)` (adds the block and drops the link), `blockedOn(hostId)`, `clearHostBlocks(hostId)`. Never exposed through `list()`.

`HostPairingLinks` (`electron/remote-control/host-links.ts`), all on its serial queue:

- `linkOne` skips a blocked host. Before replacing a device's stale link it calls `settle`: one `listDevices`. If the link is **still listed**, it is owed a revoke and re-minted, as today. If it is **absent and its room differs** from the status room, the host was reset elsewhere: drop the link and mint. If it is **absent otherwise** (same room, or a legacy link without a room), it was revoked on the host: block and mint nothing. A failing `listDevices` mints nothing.
- `reconcileLinks(hostId)` runs on each owner-channel connect from `HostServerSync.sendAll`, after `revokePending`. It runs the same `settle` over the host's links, less those owed a revoke.
- `revokeOnHost(hostId, hostDeviceId, revoke)`: `hosts.revokeDevice` goes through it and blocks the device whose link it was.
- `setLinkPhones(hostId, true)` clears the host's blocks: turning the switch off and on re-admits.
- Blocks **survive a key reset**. A reset is a security action, and widening who may reach the host should not be its side effect.

Checking inside `linkOne`, not only at connect, is what does the work: the owner channel can stay up for days, and the phone's next hello would undo a revoke made on the box long before the next connect.

### D3. Revoke handler and the Hosts page

`hostsRevokeDevice` goes through `revokeOnHost`. `HostServerView` gains `blockedDevices: {id, label}[]` from `blockedOn`, the host away included. Under the "Devices can reach" switch, `HostRow` shows a hint (`data-testid="host-blocked-devices"`): "Orry's phone was removed on <host>. Turn the switch off and on to pair it again." (plural form for several devices).

### D4. Phone Hosts sheet

An indirect host whose room this browser declined reads "Removed here · only through <desktop>" with **Connect directly** (still the one way back short of a QR). An indirect host not declined reads "Only through <desktop>" with no button: the desktop links it on its next hello unless it decided not to (switch off, blocked, relay down), and no phone-side button changes that.

### D5. Docs

`CONTEXT.md` **Paired device**, and an amendment line on ADR-228 D9.

### Rejected

- **Blocks on `PersistedHost`** (keyed by desktop device id). A device revoke would have to scan every host record, and `hostLinks` already set the precedent that a device's standing on hosts lives with the device and dies with its revoke.
- **Marking the link `revoked: true`.** Every reader of `hostLinks` (`linksOn`, `linkedOn`, cascade, mint reconciliation) would have to filter it, and the cascade would re-revoke dead ids.
- **Detection only on connect.** Too late (see D2).
- **A host-side "last reset" fact.** The room id already changes on reset.
- **A mint rate limit.** The phone only asks from a desktop hello, plus the once-per-room guard in D1; each mint revokes the previous link, so nothing piles up.
- **Removing "Connect directly".** Still needed for rooms removed by hand.

## Consequences

- A phone refused by a host reconnects on its own. A reset or moved host is relinked in the same page load. A pairing revoked on the host stays blocked until the switch is turned off and on, and the Hosts page says so.
- Links from before this ADR have no `roomId`, so one missing from its host is taken as revoked. That only bites a host reset elsewhere before upgrading, and the switch recovers it.
- A host whose device file was wiped but whose relay identity was kept blocks every linked phone there (it looks the same as every phone revoked). Visible, and the switch recovers it.
- One extra `listDevices` per owner connect while links exist, and one per mint that replaces a lost link.
- `sendAll` waits on the links queue, so a slow mint on another host slightly delays this host's endpoint refresh.
- Phone and desktop must ship together: a phone that stops declining against an older desktop would re-mint after a host-side revoke. One release covers both.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
