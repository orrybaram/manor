---
title: Reopen grace period lives on the server; restored panes get their cwd and title back
status: in-progress
priority: high
assignee: opus
blocked_by: [3]
---

# Reopen grace period lives on the server; restored panes get their cwd and title back

Regression found by ticket 3. Before ADR-179, closing a terminal pane did
not kill its session for ~10 s (`schedulePtyKill` in
`useTerminalLifecycle.ts`), so `reopenClosedPane` reattached a still-warm
shell with its scrollback, cwd and title. Ticket 2 moved the kill to the
server (`LayoutStore.apply` → `effects.killPanes` → `backend.pty.kill`)
**immediately**, so reopen now spawns a fresh shell and the restored pane
loses its `cwd`/`title` (the server has both in `paneSessions` but does not
broadcast them).

## Server

- `electron/layout/layout-store.ts` — `effects.killPanes` schedules the kill
  after `REOPEN_GRACE_MS` (match the renderer's old constant; export it) and
  records the pending kill keyed by `paneId`. `reopen-closed-pane` cancels the
  pending kill for every pane it restores, so the reattach is warm — the
  reducer's `closedStack` entry already names the panes. `flush()` on quit
  runs pending kills immediately (do not leave orphans). A pane that is
  killed by anything else in the window (daemon exit) is simply gone; the
  reopen then falls back to fresh, as it does today for a pane closed longer
  than the grace.
- Broadcast `paneSessions` for the panes a `reopen-closed-pane` restores —
  add `restored?: Record<paneId, PersistedPaneSession>` to the
  `layout.changed` payload (only on that command). Do **not** start
  broadcasting every `paneSessions` change; the renderer hears PTY events
  itself.
- Delete the renderer's `schedulePtyKill`/`closedPaneIds` grace mechanism
  once the server one is in (`useTerminalLifecycle.ts`,
  `useTerminalConnection.ts`, `app-store.ts`) — one grace, on the server.
  Unmount of a closed pane is a plain `detach`.

## Renderer

- `applyLayoutChanged` (app-store) — when a broadcast carries `restored`,
  seed `paneCwd`/`paneTitle`/`paneAgentStatus` for those panes before the
  layout replace, so the pane mounts with them (as `loadPersistedLayout`
  does at boot).

## Tests

- `layout-store.test.ts` — `close-pane` does not call `backend.pty.kill`
  until the grace elapses (fake timers); `reopen-closed-pane` within the
  grace cancels it and the broadcast carries `restored` with the pane's
  cwd/title; after the grace the kill runs once; `flush()` runs pending kills.
- Store test — a broadcast with `restored` seeds the side maps.
- E2E — extend `duplicate-tab.spec.ts` or `smoke.spec.ts`: close a terminal
  pane with a distinctive cwd/title, reopen via the palette within the grace,
  assert the title is back and the shell history is intact (type `echo` before
  closing and see it in scrollback after).

## Files to touch
- `electron/layout/layout-store.ts` (+test) — grace, cancel, `restored`
- `src/store/app-store.ts` (+test) — seed from `restored`; delete `closedPaneIds` grace bits
- `src/hooks/useTerminalLifecycle.ts`, `src/hooks/useTerminalConnection.ts` — delete `schedulePtyKill`
- `src/electron.d.ts` — `layout.changed` payload gains `restored?`
- `tests/e2e/*.spec.ts` — one reopen scenario
