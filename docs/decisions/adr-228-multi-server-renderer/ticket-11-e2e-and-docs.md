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
