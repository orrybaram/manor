---
title: "Desktop: revoke handler and the Hosts page hint"
status: review
priority: high
assignee: sonnet
blocked_by: [1]
---

# Desktop: revoke handler and the Hosts page hint

Implements ADR-238 D3. Ticket 1 added `HostPairingLinks.revokeOnHost` and `blockedOn`.

- `electron/bridge/handlers/hosts.ts`:
  - When `ctx.deps.hostLinks` exists, `hostsRevokeDevice` runs through `ctx.deps.hostLinks.revokeOnHost(hostId, deviceId, () => connectedServer(ctx, hostId).api.remoteControl.revoke(deviceId))`. Otherwise it behaves as today. It still calls `pairingChanged`.
  - `HostServerView` (~297) gains `blockedDevices: Array<{ id: string; label: string }>`, with a doc comment.
  - `hostsServerStatus` fills it from `(ctx.deps.hostLinks?.blockedOn(hostId) ?? []).map(({ deviceId, label }) => ({ id: deviceId, label }))`, the host away included (like `linkPhones`). Check any type that `hostLinks` deps are declared with and add the methods.
- `src/store/host-store.ts`: the default view (~173) adds `blockedDevices: []`.
- `src/components/settings/HostsPage/HostRow.tsx`: under the "Devices can reach" switch row (~270), when `view.blockedDevices.length > 0`, add a hint `<p data-testid="host-blocked-devices">`. Copy:
  - one device: "<label> was removed on <host>. Turn the switch off and on to pair it again."
  - several: "<a>, <b> and <c> were removed on <host>. Turn the switch off and on to pair them again."
  - Put the wording in a pure, exported `blockedDevicesLine(labels: string[], hostName: string)`. Style it like existing hint text in that file or module.css.

## Tests
- `electron/bridge/handlers/__tests__/hosts.test.ts`:
  - the existing `hostLinks` fakes add `blockedOn: vi.fn().mockReturnValue([])` (and `revokeOnHost` where needed)
  - new: revoke goes through `revokeOnHost` and still reports pairing changed
  - new: `hostsServerStatus` carries `blockedDevices` from `blockedOn`, with the host away too
- `src/components/settings/HostsPage/__tests__/HostsPage.test.ts`: the fixture adds `blockedDevices: []`; new tests cover `blockedDevicesLine` for one and for several devices, and the hint rendering if that file already renders rows.

## Files to touch
- `electron/bridge/handlers/hosts.ts`
- `src/store/host-store.ts`
- `src/components/settings/HostsPage/HostRow.tsx` (and its module.css if needed)
- `electron/bridge/handlers/__tests__/hosts.test.ts`
- `src/components/settings/HostsPage/__tests__/HostsPage.test.ts`

Acceptance: `pnpm typecheck` and `pnpm test:unit` pass.
