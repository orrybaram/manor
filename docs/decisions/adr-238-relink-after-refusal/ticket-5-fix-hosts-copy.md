---
title: "Fix: Device access copy counts blocked devices; hint contrast"
status: done
priority: medium
assignee: sonnet
blocked_by: [2]
---

# Fix: Device access copy counts blocked devices; hint contrast

Found by the e2e evidence run on the desktop Settings → Hosts row (`HostDeviceAccess` in `src/components/settings/HostsPage/HostRow.tsx`):

1. With devices blocked, the switch's description still says "Your 1 device reach manor-e2e directly" right above "linked phone was removed on manor-e2e…". The count is `useRemoteControlStore((s) => s.status.devices.length)` (~line 249) and includes blocked devices.
   - Subtract the devices in `view?.blockedDevices` (match by id against the store's device ids, so counts can't go negative).
   - Fix the grammar: "Your device reaches" / "Your 2 devices reach" (find where the string is built, likely `host-settings-text.ts`).
   - When every device is blocked (count 0), use whatever the existing zero-device wording is.
2. `.blockedHint` in `HostsPage.module.css` uses 11px and `--text-dim`, which has low contrast in the light theme. Match the size and colour token of the switch row's own description text so the hint reads as part of that row.

## Tests
- `src/components/settings/HostsPage/__tests__/HostsPage.test.ts`: the device-count wording for 1 and for 2 devices, and with one of two blocked (reads as one device).
- If the wording lives in a pure function, test that function directly.

## Files to touch
- `src/components/settings/HostsPage/HostRow.tsx`
- `src/components/settings/HostsPage/host-settings-text.ts`
- `src/components/settings/HostsPage/HostsPage.module.css`
- `src/components/settings/HostsPage/__tests__/HostsPage.test.ts`
