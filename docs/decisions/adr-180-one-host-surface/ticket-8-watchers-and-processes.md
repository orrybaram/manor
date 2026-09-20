---
title: ports, processes, branches and diffs cross
status: in-progress
priority: medium
assignee: sonnet
blocked_by: [6]
---

# ports, processes, branches and diffs cross

ADR-180 D8. Four watcher-backed namespaces: `ports` 7, `processes` 6,
`branches` 3, `diffs` 6 — 26 `ipcMain` registrations across `ipc/ports.ts`,
`ipc/processes.ts` and `ipc/branches-diffs.ts`.

## What crosses

All of it. `processes.list` is already on the table; the rest of `processes.*`
kills things (`kill`, `killAll`, `killPort`, `killDaemon`, `restartPortless`)
and was deliberately absent for slice 1. Under D4 they are ordinary entries —
a `full` device already reaches `POST /processes/kill`-shaped power through
the route table, and ADR-178 D3 settled that argument — and every one of them
goes in `MUTATING`.

Lift-and-delete as in ticket 6: a function per method over `IpcDeps`, keeping
its validation; table entry; delete the `ipcMain.handle`; drop the namespace
from `manorHost.native`.

## Events

`ports/changed`, `branches/changed` and `diffs/changed` became broadcasts in
ticket 4. Here the desktop stops listening on `ports-changed`,
`branches-changed` and `diffs-changed` and subscribes instead; delete the
`window.webContents.send` loops in `electron/ports.ts`,
`electron/branch-watcher.ts` and `electron/diff-watcher.ts` if ticket 4 left
them in place.

`useBranchWatcher`, `useDiffWatcher` and the ports store keep their current
shape — the method names do not change, only what is under them.

## Watch for

The watchers push on an interval to *every* window. Through the broadcast sink
they now also reach every socket, which is correct (a browser wants its branch
badges) but means a `read`-tier device must not get them — only `full` devices
hold a bridge connection at all, so this is already true; confirm it rather
than assume it.

## Files to touch
- `electron/bridge/handlers.ts` — ~24 new entries, `MUTATING` for the killers
- `electron/ipc/ports.ts`, `electron/ipc/processes.ts`, `electron/ipc/branches-diffs.ts` — lift, delete `register()`
- `electron/ports.ts`, `electron/branch-watcher.ts`, `electron/diff-watcher.ts` — publish only, no direct sends
- `electron/preload.ts` — remove the four namespaces
- `src/hooks/useBranchWatcher.ts`, `src/hooks/useDiffWatcher.ts` — verify only; no change expected
