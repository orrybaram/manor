---
title: Pair a phone with a host from the desktop, and dedupe push
status: todo
priority: medium
assignee: sonnet
blocked_by: [3, 4]
---

# Pair a phone with a host from the desktop, and dedupe push

ADR-218 D3 and D4.

- Remote Control page:
  - One section per remote host with a running host server, showing status (version, paired devices) from `hostServer.status()`.
  - A "Pair a phone" button calls `remoteControl.pair` on that host through `HostServerClient` and shows the QR with the existing pairing UI component.
  - Revoke is per device.
  - Show the secret backend from `hostServer.status().secretBackend`. When it is `plaintext`, show "Pairing keys on \<host\> are stored unencrypted" with a link to the docs section on enabling systemd-creds.
  - **Reset pairing keys** shows a confirmation in the page, never `confirm()`. It calls a new owner method, `hostServer.resetIdentity()`, which:
    - generates a new relay identity;
    - revokes every device and push subscription;
    - deletes any delegated integration tokens.
    The relay connector then reconnects to the new room.
- Bridge: new desktop methods `hosts.serverStatus(hostId)`, `hosts.pairDevice(hostId)`, `hosts.revokeDevice(hostId, deviceId)`. These are LOCAL_ONLY.
- Push dedupe: before the desktop sends a push about an agent on host H, skip any subscription whose endpoint appears in H's `hostServer.status().pushEndpoints`. Cache the endpoints per host and refresh them on connect.
- Copy: say plainly that this phone reaches only that host, and keeps working while this computer sleeps.

## Files to touch
- `src/components/settings/RemoteControlPage.tsx` (or wherever pairing UI lives)
- `electron/bridge/handlers/` (a hosts namespace)
- `electron/remote-control/push.ts` or the notification sink in `app-lifecycle.ts`
