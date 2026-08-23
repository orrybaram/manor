---
title: Manage a paired device without re-pairing it
status: todo
priority: medium
assignee: sonnet
blocked_by: []
---

# Manage a paired device without re-pairing it

The device list shows label, creation time, last seen, send capability, and whether push
is subscribed. Everything on it is read-only except the trash icon, so the only way to
change anything about a paired device is to revoke it and pair again — which on a phone
means re-scanning a QR code, and after ticket 10 also re-installing the Home Screen app.

- **Toggle the send capability in place.** This is the one that matters: the natural
  workflow is pairing read-only, then wanting to answer a prompt an hour later. Turning it
  *on* is a privilege escalation and deserves the same confirmation that pairing with it
  does; turning it off should be instant and unceremonious. Both go in the audit log —
  a capability grant is at least as interesting after the fact as a send.
- **Rename a device.** Labels are how a user decides which row to revoke; "iPhone" twice
  is a bad position to be in during an incident.
- **Mute push per device** without revoking it, for a device that should still be able to
  look but should stop buzzing. Distinct from the global notification preference, which
  ticket 8 already respects.
- **Send a test push** to one device, so a user can tell "push is broken" from "nothing
  has needed me yet" — which on iOS, where push depends on the install state from ticket
  10, is otherwise genuinely hard to determine.

Revocation stays immediate and stays the blunt instrument it is; none of this softens it.

Tests: a capability change takes effect on the next request with no re-pair; granting is
audited; a muted device receives no push while an unmuted one does; a test push does not
depend on any session transition.

## Files to touch

- `electron/remote-control/devices.ts` — mutate label, capability, push mute.
- `electron/remote-control/controller.ts` and the IPC surface.
- `electron/remote-control/push.ts` — respect the per-device mute; test push.
- `src/components/settings/RemoteControlPage.tsx` — the row controls.
- `src/components/settings/RemoteControlDialogs.tsx` — the escalation confirmation.
- `electron/remote-control/__tests__/devices.test.ts`, `push.test.ts`.
