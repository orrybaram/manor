---
title: Remote control becomes the Devices page
status: todo
priority: high
assignee: sonnet
blocked_by: [2]
---

# Remote control becomes the Devices page

ADR-233 D3. Rename and slim the remote-control page now that the switch and
host sections live on Hosts (tickets 1–2).

## What to build

- Rename the settings page type `"remote"` → `"devices"` everywhere
  (`settings-search.ts` `SettingsPage` union and entries, `SettingsModal.tsx`
  nav + routing, any `goTo({ type: "remote" })` callers; grep for
  `type: "remote"` and `"remote"` in `src/components/settings`). Nav label
  **Devices**, nav test id `settings-nav-devices`. Rename the component and
  file to `DevicesPage.tsx`.
- Page content, top to bottom:
  - Hint: "Check on your agents from your phone or another browser. Every
    device reaches every host that allows devices."
  - The web-app read-only note and `error` line, as today.
  - **Paired devices**: today's Devices list, empty state and **Add device**
    button (`remote-add-device`), unchanged behaviour. Drop "Reset relay
    address…" (now on This Mac's row).
  - **Open on a paired phone**: the re-entry QR block from `StatusCard`
    (`remote-open-app`), shown under the same condition.
  - **Hosts your devices can reach**: one compact row per host, This Mac
    first: status dot, name, kind, and reach in words ("Reachable while Manor
    is open" / "Reachable anytime" / "Reachable" / "Devices off"), each row a
    `Button variant="link"`-style control calling
    `goTo({ type: "hosts" }, \`host-${hostId}\`)`; header shows "N of M" and a
    "Manage in Hosts" link. Max height with internal scroll.
- Remove `StatusCard` and `HostPhoneAccessList` from this page. Delete
  `HostPhoneAccess.tsx`. Remove `DeviceRow`'s `via` prop if nothing else uses
  it, and `AddDeviceDialog`'s `hostName` variant if nothing else uses it
  (`ResetRelayDialog` keeps `hostName`).
- `AddDeviceDialog` copy: "The device gets full control of Manor, including
  terminals and workspaces, on every host that allows devices. Today that's
  {hosts}." Pass the reachable host names in.
- `settings-search.ts`: page label "Devices", keywords keep "remote",
  "remote control", "phone", "relay"; move the `remote-relay` section entry to
  the Hosts page (section `host-local` or whatever ticket 2 used).

## Files to touch
- `src/components/settings/RemoteControlPage.tsx` → `src/components/settings/DevicesPage.tsx`
- `src/components/settings/HostPhoneAccess.tsx` — delete
- `src/components/settings/RemoteControlDialogs.tsx` — dialog copy, drop unused `hostName` on AddDeviceDialog
- `src/components/settings/DeviceRow.tsx` — drop `via` if unused
- `src/components/settings/SettingsModal/SettingsModal.tsx` — nav + routing
- `src/components/settings/SettingsModal/settings-search.ts` — page type, labels, sections
