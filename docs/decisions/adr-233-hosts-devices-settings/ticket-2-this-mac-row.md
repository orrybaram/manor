---
title: This Mac row holds the remote-control switch and reset
status: todo
priority: high
assignee: opus
blocked_by: [1]
---

# This Mac row holds the remote-control switch and reset

ADR-233 D2. Replace the read-only `<HostCard hostId={null} />` at the top of
Settings → Hosts with a collapsible This Mac row in the same shape as ticket
1's `HostRow`.

## What to build

- Move the remote-control status logic out of `RemoteControlPage.tsx` into a
  shared module (e.g. `src/components/settings/remote-control-status.ts`):
  `isOn(status)`, `describe(status)` and the `StatusView` type. Both pages
  import it.
- This Mac row:
  - Header: laptop icon, "This Mac", status line "Local · Manor {version} ·
    devices reach it while Manor is open" when on, "· devices off" when off,
    "· can't reach the relay" when failed. (Get the version the way the app
    shows it elsewhere; drop it if there is no cheap source.)
  - Body, group "Device access": **Devices can reach This Mac** switch
    (keep `data-testid="remote-control-switch"`, `aria-label="Remote
    control"`), wired exactly like `StatusCard`: on → `RelayConfirmDialog`
    (`remote-relay-confirm`) → `turnOn()`; off → `turnOff()`; locked in the
    web app, while busy, or without `encryptionAvailable`. Hint is
    `describe(status).detail`. "Try again" button (`remote-relay-retry`) when
    `describe` returns a retry. `relayNotice` (`remote-relay-notice`) and the
    encryption warning below it. Keep a wrapper with
    `data-testid="remote-relay-card"` whose text contains
    `describe(status).title` ("Remote control is on" etc.) because the e2e
    helper waits on that text.
  - Footer: **Reset pairing keys…** (`remote-relay-reset`, shown when there are
    devices) → `ResetRelayDialog` → `resetRelayAddress()`.
- Make `HostRow` (ticket 1) generic enough to host this body, or share a
  `HostRowShell` (header + collapse + footer) between the two. Do not duplicate
  the expand/collapse markup.
- `RemoteControlPage` keeps working after this ticket: leave its `StatusCard`
  in place for now (ticket 3 removes it) but have it import from the shared
  module.

## Files to touch
- `src/components/settings/remote-control-status.ts` — new, moved from `RemoteControlPage.tsx`
- `src/components/settings/HostsPage/ThisMacRow.tsx` — new
- `src/components/settings/HostsPage/HostRow.tsx` — extract the shared shell
- `src/components/settings/HostsPage/HostsPage.tsx` — render `ThisMacRow` first
- `src/components/settings/RemoteControlPage.tsx` — import the moved helpers
