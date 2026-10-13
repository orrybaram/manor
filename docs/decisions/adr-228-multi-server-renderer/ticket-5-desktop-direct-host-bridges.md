---
title: Desktop renderer talks to host servers directly, terminals included
status: todo
priority: critical
assignee: opus
blocked_by: [3, 4]
---

# Desktop renderer talks to host servers directly, terminals included

ADR-228 D4 and D5 (desktop renderer), and D6 (away hosts on the desktop).

## Do
- **Server set on the desktop.** In `install-desktop.ts`, or a small
  `src/bridge/desktop-hosts.ts`, watch `hosts.list` / `hosts.onStatusChanged`.
  - For each host that is adopted and `viewerBridge`, add a server whose id is
    the desktop hostId. Its transport is
    `createWsTransport({pipe: hostPipe(hostId), preAuthenticated: true})`.
  - Remove the server when the host is removed.
  - A host without `viewerBridge` gets no entry, and keeps going through
    main's `HostRouting` (D3).
- **Remote panes on the host bridge.**
  - `useTerminalConnection`, `useTerminalStream` and `useTerminalLifecycle`
    need no API change: the router sends `pty.*` by `byPane`.
  - Check that `pty.create`'s `hostId` option is stripped by the rewrite. To
    the host, the pane is local.
  - Check the follower/owner flow with the new ranking from ticket 2.
- **Away hosts.**
  - `isHostOffline`, `HostOfflineBanner`, `HostAlert` and the recovery hooks
    (`useRemoteRecovery`, `useTerminalResync`, `remote-pane-store`) read the
    host's source reachability from the server set.
  - When the direct source is unreachable, the router falls back to the home
    server. Main's `HostRouting` serves the cache, as in slice 2.
- **Viewport and claims.** `layout.reportViewport` for a remote workspace
  goes home (D7). Mark it `"home"` in `ROUTES`, and check that a detached
  window's claim on a remote tab now holds.
- **E2E.** In the remote-host suite:
  - a pane on a remote host types and resizes over the direct bridge;
  - killing the viewer stream falls back and recovers;
  - a host with an old server (no `viewer-bridge`) still works through main.

## Files to touch
- `src/bridge/install-desktop.ts`, `src/bridge/desktop-hosts.ts` (new)
- `src/lib/host-status.ts`, `src/components/TerminalPane/HostOfflineBanner.tsx`,
  `src/components/HomeDashboard/HostAlert.tsx`
- `src/hooks/useRemoteRecovery.ts`, `src/hooks/useTerminalResync.ts`,
  `src/store/remote-pane-store.ts`
- `electron/bridge/routes.ts` (`layout.reportViewport` home)
- `e2e/` remote-host specs
