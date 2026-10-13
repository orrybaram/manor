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
