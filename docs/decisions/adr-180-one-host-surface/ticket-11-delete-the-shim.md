---
title: Delete the shim — preload's final shape
status: done
priority: high
assignee: sonnet
blocked_by: [7, 8, 9, 10]
---

# Delete the shim — preload's final shape

ADR-180 D8. Every non-native namespace has crossed. Remove what is now dead
and write down what `electron/ipc/` means from here on.

## What survives

`electron/ipc/` keeps exactly six things, and its new header says why: they
are what only Electron can do (ADR-178's "what can never mirror in a browser"
table).

- `webview.ts` (757 lines, 14 registrations) and `webview-keys.ts`
- `window.ts` (5) — detach-to-window
- `popups.ts` — `registerChildWindow`
- `menu.ts` (1) — the native app menu
- the dialog / shell / clipboard / updater remnant of `misc.ts`, which should
  be renamed to say so (`native.ts`)

`preload.ts` ends as: the argv-derived facts, `invoke`, `subscribe`, and
`native: { webview, window, menu, dialog, shell, clipboard, updater }`. It
should be well under 300 lines. The `onChannel` helper stays only if a native
namespace still needs it.

## What goes

Delete outright: `electron/ipc/layout.ts`'s, `viewport.ts`'s, `projects.ts`'s,
`pty.ts`'s, `theme.ts`'s, `agents.ts`'s, `notifications.ts`'s, `stats.ts`'s,
`ports.ts`'s, `processes.ts`'s, `branches-diffs.ts`'s, `integrations.ts`'s and
`remote-control.ts`'s `register()` functions, and any file left with nothing
but imports. The lifted bodies live under `electron/bridge/handlers/` by now;
move any that are still sitting in `electron/ipc/` and delete the file.

`electron/main.ts` and `electron/app-lifecycle.ts` stop calling the deleted
`register()`s. `electron/ipc-validate.ts` is shared by the lifted functions —
it stays, and its test with it.

Check with `/usr/bin/grep -rn "ipcMain\." electron | /usr/bin/grep -v bridge`:
what remains must be the six survivors plus the four `bridge:*` channels, and
nothing else.

## Verification beyond typecheck

`pnpm build` is the gate (typecheck alone will not catch a deleted
registration whose caller went over the bridge). Then start the app and touch
one thing per crossed namespace: open a project, split a pane, change the
theme, stage a file, open the keybindings page, check the notification
centre. A method that resolves to nothing is a rejected promise in the
console, not a crash — read the console.

## Files to touch
- `electron/ipc/misc.ts` → `electron/ipc/native.ts` — the dialog/shell/clipboard/updater remnant, renamed with a header saying why it survives
- `electron/ipc/` — delete the thirteen migrated modules
- `electron/ipc/types.ts` — stays; `IpcDeps` is the handler table's deps object now, and its header should say so
- `electron/preload.ts` — final shape
- `electron/main.ts`, `electron/app-lifecycle.ts` — drop the deleted registrations
- `src/electron.d.ts` — no interface change; the comment on `platform` gets the new story

## Folded in from ticket 6

Every crossing so far has left its lifted bodies in `electron/ipc/<ns>.ts` and
deleted only the `register()` — ticket 5's `pty` template, followed by every
ticket since. So this ticket's move is not a tidy-up of one module: it is
**every crossed namespace's implementation** relocating to
`electron/bridge/handlers/`, and `electron/ipc/` keeping only the six native
survivors. Budget for that.

A small thing to decide while you are there: `projects.onWorktreeProgress` and
`projects.onRemoveWorktreeProgress` are two addressed progress channels doing
one job. They could collapse. Only do it if it is free; it is not this ADR's
business.
