---
title: E2E pass, glossary and docs
status: todo
priority: medium
assignee: sonnet
blocked_by: [5, 6, 8, 9, 10]
---

# E2E pass, glossary and docs

ADR-228, all decisions.

## Do
- **Full E2E.** Run the remote-host and phone suites end to end on this box.
  Setup is in `docs/remote-hosts.md#testing`. Compare against the known
  Linux failures listed there, and fix regressions this ADR caused.
- **`CONTEXT.md`.** Update these entries:
  - **Bridge:** the renderer holds one per reachable server, behind a
    router.
  - **Host:** the renderer attaches to every host at once. Replace "exactly
    one at a time".
  - **Paired device:** one pairing with the desktop links the host rooms
    (D9).
  - **Owner channel:** mention desktop viewer streams.
  - **Winsize owner:** a desktop viewer is ranked on the host.
  - **Relationships:** the device-switching bullet.
  - Add terms for **Server set**, **Router** and **Source**, with
    `_Avoid_` lines.
- **`docs/remote-hosts.md`:**
  - viewer streams;
  - linked pairings and the per-host switch;
  - Linear via the desktop;
  - the old-host fallback.
- **ADR-228.** Add a "Known limits as built" section if anything shipped
  differently.

## Files to touch
- `CONTEXT.md`, `docs/remote-hosts.md`
- `docs/decisions/adr-228-multi-server-renderer/index.md`
- `e2e/` as needed

## Carried over from ticket 5
- `remote-host.spec.ts` "remote restart" fails when it runs after another
  test in that serial file, because the box keeps the adopted project and
  there is no onboarding button. It fails on the base too. Add a `beforeEach`
  box reset. "ports" then runs too.
- `host-server.spec` and `host-ownership.spec` need `pnpm build:web:relay`
  first.

## Carried over from ticket 6 (commit c0ac3065): candidates for "Known limits as built"
- **Callers routed through main share one host viewer.** Every caller main
  forwards for a remote pane (phones on the desktop, a window falling back)
  uses main's owner channel. They all get the same `winsizeOwner` and can
  fight over resizes, because main doesn't rank its own callers for remote
  panes.
- **A claim on a remote tab** that leaves the host's tree isn't dropped on
  main (`dropClaimsOnGoneTabs` runs for local workspaces only). It lasts
  until the window closes.
- **Lookup cost.** `HostProxy.layout()` copies entries and calls `claimsFor`
  on each call, and `workspaceOfPane` is called per routed pane call,
  keystrokes included. This is fine at today's sizes; index it later.
- **Older host servers.** A host server older than this branch lacks
  `pty.reset` and `pty.close` until its tarball upgrade runs.
- **Panes attached before adoption.** A pane main attached through the
  daemon before adoption, in the same run, keeps its daemon subscription
  until main restarts.

## Carried over from ticket 7
- `docs/remote-hosts.md#testing` should list `phone-all-pairings.spec.ts`.
- "Known limits as built" candidates:
  - `branches.start` / `diffs.start` go to home only; home drops workspaces
    for hosts it doesn't know, so branch/diff watching for host-server-only
    workspaces on the phone is off. Proper fix: split per server and merge.
  - `projects.getSelectedIndex` / `select` index home's list, not the merged one.
  - The fallback id is `<desktopRoom>~<hostId>` (ADR text says `/`):
    `workspaceKey` can't hold `/`. Update D2.
  - Hosts sheet opens from the drawer's bottom nav, not the top-bar menu.
- web-app e2e 255, 470, 566 fail on a3058ed1 too (pre-existing).

## Carried over from ticket 8
- Fix if small, else list under "Known limits as built":
  - `HostIndicator`'s icon and status chip (`useHostDisplay`) read only
    direct reachability; a host away because its desktop is gone keeps a
    stale connected glyph while its row is dimmed. Pass `useViaReachability`.
  - `useTerminalConnection`'s write guard calls `isHostOffline` without
    `via`, so input to such a host isn't blocked.
  - `memberHostName` still says "This machine" on the phone in
    `RemoveFromHostDialog`, `SettingsModal`, `transfer-targets`; use
    `serverHostName` (`src/bridge/server-set.ts`).

## Carried over from ticket 9
- **Fix:** a desktop-minted host pairing that the user removes in the phone's
  Hosts sheet (or revokes as a "via This Mac" row on the host) is minted
  again on the next desktop hello. Have the phone remember declined rooms
  (in `src/bridge/pairings.ts`) and send them in `heldRooms`; clear the
  memory when the user re-pairs that room by QR.
- **Fix if small, else known limit:** a pane's `chat`/`pty` subscription
  opened while its direct source is "unknown" stays on that source if it
  never connects, with no fallback to the desktop (`src/bridge/router.ts`).
  Ticket 9 avoids it by not minting while a host's relay is down.
- Known limit: a host-server reset mid-mint can leave the minted host
  device unlinked.
- `docs/remote-hosts.md#testing` should list `phone-linked-hosts.spec.ts`.
