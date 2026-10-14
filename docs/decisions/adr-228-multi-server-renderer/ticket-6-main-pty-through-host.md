---
title: Main forwards remote pty through the host server; drop daemon attach
status: in-progress
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

## Carried over from ticket 5 (commit b085648a)
- **Main doesn't carry a direct pane's output today.** While a window's
  viewer stream is down, typing reaches the box through main (by
  `paneHostOf`), but the screen only catches up when the stream returns.
  After a host-drop recovery that went through main, main is attached again
  through the daemon, and the window can drop to follower. This ticket's
  pty forwarding through the host fixes both. Add a unit or e2e check for
  "stream down → output still arrives through main".
- **`pty.write` over a dropped stream** rejects with `BridgeDisconnectedError`
  and nothing catches it. The router (or `useTerminalConnection`) should fall
  back to home for a write while the direct source is down, or at least
  catch it.
- **Detached-window claims on remote tabs (ADR D7).** `reportViewport` now
  goes home in the renderer overlay, but main's table still routes it
  `byWorkspaceKey` to the host, and remote layout entries never include main's
  window claims. Fix it here, since this ticket already changes main's
  `HostRouting`:
  - make `layout.reportViewport` `LOCAL_ROUTE` in main's table and in `ROUTES`;
  - have main merge its window claims into remote workspaces' layout
    entries, in its merged `layout.getAll` and in what the router merges.
  - Add a test that a detached window's claim on a remote tab holds.
- `RoutedBackend.paneHostOf` (added in ticket 5) is the fallback main uses to
  find a direct pane's host. Keep it working once the daemon attach is gone.
