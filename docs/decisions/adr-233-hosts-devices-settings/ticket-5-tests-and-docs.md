---
title: Update e2e specs, helpers and docs for the new pages
status: todo
priority: medium
assignee: sonnet
blocked_by: [3, 4]
---

# Update e2e specs, helpers and docs for the new pages

ADR-233 Consequences. Tickets 1–4 moved controls between pages; bring the
tests and the user docs along.

## What to do

- `tests/e2e/helpers/settings.ts`: `openRemoteControlSettings` now opens
  Settings → Hosts and expands This Mac's row (the switch lives there); add an
  `openDevicesSettings` helper (`settings-nav-devices`) and use it wherever a
  spec pairs or revokes a device. `enableRemoteControl` keeps working through
  the This Mac row.
- `tests/e2e/phone-linked-hosts.spec.ts` and `tests/e2e/lid-closed.spec.ts`:
  the per-host section (`host-phone-access`, `host-phone-summary`,
  `host-link-phones-toggle`) is now inside the host's row on Settings → Hosts;
  navigate there and expand the row (`host-entry[data-host-id=…]`) first.
  Assertions on per-host device lists ("linked phone" rows) no longer have a UI;
  replace them with what the UI now shows (the device on the Devices page, the
  host's reach text) or drop them with a comment saying why.
- Grep `tests/e2e` for any other test id removed by tickets 1–4 and fix it.
  Do not run the e2e suite unless the environment supports it (see memory
  notes on this box); at minimum run `pnpm typecheck` (or the repo's
  equivalent) over the specs.
- Unit tests: run the renderer unit tests touching settings and fix failures.
- Docs: in `docs/remote-control.md` and `docs/remote-hosts.md`, replace
  "Settings → Remote control" paths and button names with the new ones
  (Settings → Devices for pairing/revoking; Settings → Hosts → *host* for
  device access, Linear, pairing keys, reset; "Add a host…" wizard). Remove the
  "Pair a phone in that host's section" instructions (host-only pairing has no
  UI now) and say so briefly.

## Files to touch
- `tests/e2e/helpers/settings.ts`
- `tests/e2e/phone-linked-hosts.spec.ts`
- `tests/e2e/lid-closed.spec.ts`
- `docs/remote-control.md`
- `docs/remote-hosts.md`
