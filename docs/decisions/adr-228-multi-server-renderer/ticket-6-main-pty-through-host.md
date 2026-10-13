---
title: Main forwards remote pty through the host server; drop daemon attach
status: todo
priority: high
assignee: opus
blocked_by: [5]
---

# Main forwards remote pty through the host server; drop daemon attach

ADR-228 D5 ("the desktop stops attaching remote panes over the daemon
stream") and D7.

## Do
- **Forward `pty.*` for remote panes.** In `HostRouting`
  (`electron/server/host-routing.ts`), forward `pty.*` calls for a pane on an
  adopted host by `byPane`. This covers devices paired only with the desktop,
  and the desktop renderer's fallback.
  - `HostProxy` subscribes to that pane's `pty.output`, `resized`, `exit`,
    `cwd`, `error` and `winsizeOwner` on the host when a desktop connection
    subscribes to it, and unsubscribes when the last one goes.
  - It republishes those events keyed by pane. Reuse the `watchChat` /
    `publishKeyed` pattern (`electron/backend/host-proxy.ts:341`).
- **Delete the daemon attach for adopted hosts.**
  - Remove `RoutedBackend.createOrAttachWith`'s remote attach
    (`electron/backend/routed-backend.ts:144-163`).
  - Remove the matching stream fan-out branch in
    `electron/server/create-manor-server.ts:676-705`.
  - Remote pane sessions are no longer subscribed on the desktop's
    `TerminalHostClient`.
  - Keep the daemon connection for lifecycle only: `ensureRunning`, the
    tarball upgrade, port forwards and the control relay.
- **Winsize.** Main's owner channel attaching on behalf of a device ranks
  as `owner`, which equals a device. Check that the phone-via-desktop path
  still gets `pty.winsizeOwner`.
- **Tests.**
  - Host-routing unit tests for pty forwarding and event republish.
  - Delete tests that pinned the daemon-attach path.
  - The remote-host E2E for a phone paired only with the desktop.

## Files to touch
- `electron/server/host-routing.ts`, `electron/backend/host-proxy.ts`
- `electron/backend/routed-backend.ts`,
  `electron/server/create-manor-server.ts`
- `electron/bridge/routes.ts` (pty rules), `electron/bridge/handlers/pty.ts`
- related tests under `electron/server/__tests__/`,
  `electron/backend/__tests__/`
