---
title: theme, preferences, keybindings, notifications, stats cross
status: todo
priority: high
assignee: sonnet
blocked_by: [6]
---

# theme, preferences, keybindings, notifications, stats cross

ADR-180 D4/D8. Five small namespaces, and the first place `LOCAL_ONLY` earns
its keep.

Method counts from `src/electron.d.ts`: `theme` 7, `preferences` 4,
`keybindings` 7, `notifications` 7, `stats` 3. Eighteen `ipcMain`
registrations across `ipc/theme.ts`, `ipc/misc.ts`, `ipc/notifications.ts`,
`ipc/stats.ts`.

## What crosses

Everything, with the same lift-and-delete as ticket 6: export a function over
`IpcDeps` per method, keep its validation, add a table entry, delete the
`ipcMain.handle`, remove the namespace from `manorHost.native`.

Already on the table and needing nothing but the desktop switch:
`theme.get/getSelectedName/hasGhosttyConfig/preview/allColors`,
`preferences.getAll/set`, `keybindings.getAll`, `notifications.getAll`,
`stats.getSummary`.

## What is `LOCAL_ONLY`

Add to `LOCAL_ONLY` in `electron/bridge/handlers.ts`:

- `keybindings.set`, `keybindings.reset`, `keybindings.resetAll` — ADR-178
  ticket 6 made that page read-only on web, and this is where that decision
  finally lives as code rather than as an absence.
- `keybindings.runInMainWindow` — it names a window.

`theme.set` and `theme.setGhostty*` are **not** local-only: a `full` device
setting the theme is ADR-179 D6's `theme.changed` broadcast working as
designed, and the browser already re-renders on it.

`stats.reset` and `notifications.clear/markRead/markAllRead` are ordinary
table entries, and go in `MUTATING`.

## Events

`theme/changed`, `preferences/changed`, `keybindings/changed`,
`notifications/changed`, `stats/changed` are already `renderer-broadcast`
publishers. Confirm each `on*` method resolves through the client's
`SUBSCRIPTION_EVENTS` table (`preferences.onChange` → `changed`,
`keybindings.onChange` → `changed`) and that the desktop now hears them as
frames rather than on their old channels — then delete the old channels'
sends.

## Files to touch
- `electron/bridge/handlers.ts` — ~18 entries, four `LOCAL_ONLY`, the `MUTATING` additions
- `electron/ipc/theme.ts`, `electron/ipc/notifications.ts`, `electron/ipc/stats.ts` — lift, delete `register()`
- `electron/ipc/misc.ts` — lift the preferences and keybindings halves; the dialog/shell/clipboard half stays
- `electron/preload.ts` — remove the five namespaces
- `electron/remote-control/__tests__/allowlist.test.ts` — assert the `LOCAL_ONLY` list
