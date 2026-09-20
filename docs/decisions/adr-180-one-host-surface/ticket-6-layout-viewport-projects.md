---
title: layout, viewport and projects cross
status: todo
priority: high
assignee: opus
blocked_by: [5]
---

# layout, viewport and projects cross

ADR-180 D8. The biggest namespace in the app (`projects`, 25 methods, 23
`ipcMain` registrations) plus the two ADR-179 already half-moved.

## layout (7 methods, already on the table)

All seven are there. Delete `register()` from `electron/ipc/layout.ts`, remove
the `layout` namespace from `manorHost.native`, and confirm `layout.onChanged`
arrives as a broadcast frame rather than the `layout:changed` channel
`app-lifecycle.ts:261` sends — that send goes away, the broadcast sink covers
both renderer kinds.

The **origin** is the piece to be careful with. ADR-179 D3 has the server
append the caller's `LayoutOrigin` from the transport, never from the frame
(`ORIGIN_ARGS`). A desktop window's origin is now its connection id, which is
its `webContents.id` as a string — the same value `rendererId` already had, so
selection hints keep landing on the window that sent the command. Assert this
in a test; getting it wrong means every split jumps focus in the wrong window.

## viewport (2 methods, 3 registrations)

`viewport.load`/`save` read and write `~/.manor/viewport.json` — *this
machine's* primary window's viewport. Add both to the table as `LOCAL_ONLY`: a
browser keeps answering them out of `localStorage` through `LOCALLY_SERVED`,
which is already true and must stay true.

## projects (25 methods)

`projects.getAll/getSelectedIndex/select/selectWorkspace` are on the table.
Add the remaining ~21 — add/remove project, create/remove/rename workspace,
folders, reorder, hidden, quick-merge, resync, the worktree setup path, the
issue-linked creators. Lift each body out of its `ipcMain.handle` in
`electron/ipc/projects.ts` into an exported function over `IpcDeps`, exactly
as `ipc/pty.ts` already does, keeping every `assert*` call where it is.

All of them are reachable by a `full` device, and that is ADR-178 D3 as
written and as the pairing dialog's label already warns ("can do anything the
desktop can, including remove workspaces"). Add each mutating one to
`MUTATING` so it leaves an audit line.

`projects.worktreeProgress` is an event now (ticket 4); it is addressed to the
connection that called the creator, so the creator has to carry the caller's
connection id. That is what `ORIGIN_ARGS` is for — add the entry.

## Files to touch
- `electron/bridge/handlers.ts` — ~23 new entries, `LOCAL_ONLY` for viewport, `MUTATING` and `ORIGIN_ARGS` additions
- `electron/bridge/handlers/projects.ts` — new; the lifted bodies, if `handlers.ts` gets unwieldy
- `electron/ipc/projects.ts` — lift every body, delete `register()`
- `electron/ipc/layout.ts` — delete `register()`
- `electron/ipc/viewport.ts` — lift, delete `register()`
- `electron/app-lifecycle.ts` — drop the `layout:changed` send
- `electron/preload.ts` — remove the `layout`, `viewport` and `projects` namespaces
- `electron/bridge/__tests__/layout-origin.test.ts` — new; a desktop command's origin is its window
