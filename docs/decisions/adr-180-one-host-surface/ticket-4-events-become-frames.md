---
title: Every push becomes a bridge event
status: todo
priority: critical
assignee: opus
blocked_by: [2]
---

# Every push becomes a bridge event

ADR-180 D5. The desktop learns about the world through ~20 named
`webContents.send` channels; the browser learns about it through event frames.
Convert the non-native ones, including the addressed pushes that broadcast
cannot express.

## Addressed events

`BridgeServer.sendTo(connectionId, frame)` exists from ticket 1. Add to the
IPC transport a way to resolve *a window* to *a connection id* — the primary
window, the focused window, a detached window by its `windowId` — since these
sends are all "tell that one renderer". Resolution lives in the transport,
because connection-to-window is the transport's private business.

Convert:

| today | becomes |
| --- | --- |
| `renderer-bridge.ts` `win.webContents.send("app-command", …)` | `appCommands.command` to the primary's connection |
| `preload` `ipcRenderer.send("app-command-result", …)` | an ordinary `appCommands.result` invoke |
| `app-menu.ts` `target.webContents.send("menu-command", …)` | `menu.command` to the focused window's connection |
| `persistence.ts` `worktree:setup-progress` | `projects.worktreeProgress` to the requesting connection |
| `notifications.ts` `notifications:navigate` | `notifications.navigate`, broadcast |
| `updater.ts` `win.webContents.send(channel, payload)` | `updater.*`, broadcast — the *renderer-facing* half only; `updater` stays native for its invokes |

## Broadcast events

`renderer-broadcast.ts` already carries `projects/changed`,
`preferences/changed`, `keybindings/changed`, `agents/updated`,
`notifications/changed`, `stats/changed`, `layout/changed`, `theme/changed`.
The remaining `webContents.send` broadcasts join it, each as one line next to
the send it already has — never as a second detector:

- `branch-watcher.ts` → `branches/changed`
- `diff-watcher.ts` → `diffs/changed`
- `ports.ts` → `ports/changed`

Then remove the `webContents.send` itself: the IPC transport is now a sink on
`addRendererBroadcastSink`, so a broadcast reaches desktop windows and sockets
through the same call. Delete the per-window loops.

## Per-pane events

`app-lifecycle.ts` sends `pty-output-${sessionId}` and its five siblings to
every window. The bridge already turns the same `backend.pty.onEvent` stream
into `pty.output` frames with `key = paneId`. Keep **one** producer: the
`BridgeServer`'s. `app-lifecycle.ts` stops sending the per-pane channels
entirely — but only in ticket 5, where the renderer starts subscribing
instead. This ticket leaves the `pty-*` channels alone.

## Verification

- `electron/bridge/__tests__/events.test.ts`: a broadcast reaches two
  connections; `sendTo` reaches exactly one; a subscription for pane A never
  receives pane B.
- The desktop still receives `app-command` (the `manor` CLI's
  `focus-pane` path) and `menu-command` (any native menu item). These are the
  two that break silently.

## Files to touch
- `electron/bridge/transports/ipc.ts` — window→connection resolution; register as a broadcast sink
- `electron/bridge/server.ts` — `sendTo`, and the broadcast sink wiring
- `electron/renderer-bridge.ts` — `app-command` and `app-command-result` over the bridge
- `electron/app-menu.ts` — `menu-command` to the focused connection
- `electron/persistence.ts` — `worktree:setup-progress`
- `electron/notifications.ts` — `notifications:navigate`
- `electron/updater.ts` — progress pushes
- `electron/branch-watcher.ts`, `electron/diff-watcher.ts`, `electron/ports.ts` — publish instead of send
- `electron/preload.ts` — the matching `on*` methods move to `manorHost.subscribe`
- `electron/bridge/__tests__/events.test.ts` — new

## Folded in from ticket 1

Publishing used to `JSON.stringify` a frame once and write the same string to
every socket. Frames are objects now and the WS transport serialises per
connection, so a pane's output does N stringifies for N browsers. Correct but
wasteful on the hottest path in the app. Serialise once per frame in the WS
transport and write the string to each socket — the IPC transport must *not*
serialise at all (structured clone, ticket 5's throughput note).
