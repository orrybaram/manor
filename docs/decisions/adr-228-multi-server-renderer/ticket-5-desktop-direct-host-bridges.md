---
title: Desktop renderer talks to host servers directly, terminals included
status: in-progress
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

## Carried over from ticket 2
- **Winsize.** Main's `RoutedBackend` still attaches remote panes over the
  daemon stream until ticket 6. Until then, the host's foreign hold makes a
  desktop viewer a follower. The E2E for "resizes over the direct bridge"
  should expect follower behavior until ticket 6 lands, or be written so
  that ticket 6 can turn it on.
- `roomId` and `viewerBridge` in `hosts.list` only appear after the first
  status read; before that they are absent. Treat absent as "no direct
  bridge yet" and add the server when the status event arrives.

## Carried over from ticket 3
- Use `createHostPipeTransport(window.manorHost.hostPipe, hostId, {onHello,
  onStatus})` from `src/bridge/transports/host-pipe.ts`.
- Main refuses `open` with 4504 for a host that isn't adopted, isn't
  connected or lacks `viewerBridge`, and the transport retries with backoff.
  So only add a server for hosts that pass those checks in `hosts.list`, or
  the transport will dial in a loop.
- `probe` only reports whether the pipe is open. A wedged SSH line is caught
  by the host connection's own liveness checks, not by the bridge.

## Carried over from ticket 4 (commit 23bb1943)
- **API.**
  - Add a host with
    `servers.add(hostId, createHostPipeTransport(api, hostId, servers.hooks(hostId)), { capabilities: ["viewer-bridge"] })`.
  - Remove it with `servers.remove(hostId)`.
  - These live in `src/bridge/server-set.ts`. The router replays listeners
    and drops last-known state by itself.
- **Home is added with `lists: "all"`.** When a host's own server is away,
  the call falls back to main's `HostRouting`. That is already D6 on the
  desktop.
- **`pty.*` has no `byPane` rule in `ROUTES`**, so today the router sends all
  pty calls and listeners home. The handler tables must not gain a pty
  `route` here, because that changes main (ticket 6). Instead:
  - add a **renderer-only overlay** in `electron/bridge/routes.ts`
    (`RENDERER_ROUTES`, or equivalent) that the router reads on top of
    `ROUTES`;
  - mark it in the overlay as `pty.*` → `byPane` (the router already routes
    calls and listeners by pane for any `byPane` rule), and
    `layout.reportViewport` → `"home"` (D7);
  - keep the surface test's table/`ROUTES` agreement, and add a check that
    every overlay key is a real method.
- **Progress events and `agents.status` from a host reach the renderer
  unchanged.** The router only stamps `layout.changed` and `agents.updated`.
  Stamp `projects.*Progress` (worktree setup progress) and `agents.status`
  in `stampEvent` if the stores key them by host or workspace key. Check what
  `useWorktreeSetupProgress` and the pane-status store expect.
- `ServerEntry.hello.capabilities` comes only from the `add` option.
