---
title: WebSocket bridge endpoint on the remote listener
status: todo
priority: critical
assignee: opus
blocked_by: [1]
---

# WebSocket bridge endpoint on the remote listener

ADR-178 D8. One multiplexed WebSocket per web renderer, opened only by a
`full` device, carrying request/response frames for what `invoke` did and event
frames for what `on` did plus the PTY stream. The renderer talks to the Manor
server only; the daemon is proxied.

## Dependency

Add `ws` (and `@types/ws`) to `package.json`. Electron main is Node; there is
no built-in WebSocket server.

## Endpoint

- `electron/remote-control/server.ts` — handle the HTTP `upgrade` event for
  pathname `/ws`. Do **not** authenticate from the URL (a token in a query
  string is a token in a log). Accept the socket, then require a first text
  frame `{"type":"hello","token":"…"}` within 5 s; verify with the same
  `DeviceVerifier` the HTTP path uses; close with code `4401` on failure or
  timeout, `4403` if the device's capability is not `full`. The rate limiter's
  failed-auth backoff applies to failed hellos. Stop the server → close all
  sockets (extend `stop()` next to `hub.closeAll()`).
- `electron/remote-control/ws-bridge-server.ts` (new) — `WsBridgeServer`
  owning connected sockets. Frame protocol, versioned by a `v: 1` field on
  `hello`'s reply:
  - client → `{id, kind:"invoke", ns, method, args}`
  - server → `{id, kind:"result", ok:true, result}` |
    `{id, kind:"result", ok:false, error, code}` where `code` is
    `"unavailable:web"` for a method the table does not implement
  - server → `{kind:"event", ns, event, args}`
  - client → `{kind:"subscribe"|"unsubscribe", ns, event, key}` — `key` is the
    `paneId` for `pty.*` events so the server forwards only subscribed panes.
- Audit: every `invoke` whose `ns.method` is in a `MUTATING` set (`pty.write`
  is **not** — it is the terminal, and ADR-161 chose to audit sends, not
  keystrokes; `pty.create`, `pty.close`, `projects.*` writes are) lands one
  audit line: device, `ns.method`, target arg, no bodies.

## Handler table

`electron/remote-control/ws-handlers.ts` (new) — a flat
`Record<"ns.method", (deps: IpcDeps, ...args) => Promise<unknown>>`. Do not
call `ipcMain.handle` targets reflectively; lift the bodies of the handlers
you need into plain functions and have **both** `ipcMain.handle` and this
table call them (the ipc file keeps its `ipcMain.handle` wrapper and the
`assert*` validation, which the table reuses). Slice 1 set:

- `pty.create`, `pty.write`, `pty.resize`, `pty.close`, `pty.detach` — from
  `electron/ipc/pty.ts`. `pty.create` and `pty.resize` gain the follower
  behaviour in ticket 5; here they behave as on the desktop.
- `layout.load`, `layout.getRestoredSessions` — from `electron/ipc/layout.ts`.
  `layout.save` is **in the table and refuses** with `code:"unavailable:web"`
  and the message "Layout changes are not saved from the browser yet
  (ADR-178, slice 2)". Refusing beats silently dropping.
- `projects.getAll`, `getSelectedIndex`, `select`, `selectWorkspace` and the
  read side of whatever the sidebar calls on mount — read
  `src/components/sidebar/` and `src/store/project-store.ts` to get the exact
  list; do not guess.
- `preferences.get*`, `theme.get*`/`list*`, `keybindings.get*`, `daemon.*`
  status reads, `agents.*` reads (`list`, `getStatus`, whatever
  `agent-store.ts` calls on mount).
- `env.*` reads if `App.tsx` needs them at boot.
- everything else: `unavailable:web`.

## Events

Subscribe once to `backend.pty.onEvent` (the same hook
`electron/app-lifecycle.ts:371` uses for windows) and forward
`output`/`exit`/`cwd`/`resized`/`agentStatus`/`error` as `pty.<event>` frames
to sockets subscribed to that `paneId`, with the same argument shapes the
preload's `onOutput(paneId, (data, seq))` etc. deliver. Forward
`projects`/`agents`/`theme`/`preferences` change broadcasts the desktop windows
receive (find them via `webContents.send` in `electron/ipc/*.ts`) as
`ns.event` frames; the renderer store subscribes to the same names.

## Wiring

`electron/app-lifecycle.ts` — construct `WsBridgeServer` with `ipcDeps` and
hand it to `RemoteControlServer`. `IpcDeps` is what the handlers get; do not
invent a second deps type.

## Tests

- `electron/remote-control/__tests__/ws-bridge.test.ts` — hello with a bad
  token closes `4401`; a `send` device closes `4403`; a `full` device gets
  `{v:1}`; `invoke` of a table method resolves; `invoke` of an absent method
  rejects with `unavailable:web`; a `subscribe` to `pty.output` for pane A
  receives A's output and not B's; `stop()` closes sockets.

## Files to touch
- `package.json` — `ws`, `@types/ws`
- `electron/remote-control/server.ts` — `upgrade` handling, hello auth, `stop()`
- `electron/remote-control/ws-bridge-server.ts` — new, sockets and framing
- `electron/remote-control/ws-handlers.ts` — new, handler table
- `electron/ipc/pty.ts`, `electron/ipc/layout.ts`, `electron/ipc/projects.ts` and the other ipc modules named above — lift bodies into exported functions
- `electron/remote-control/audit.ts` — bridge-invoke entry
- `electron/app-lifecycle.ts` — construct and wire
- `electron/remote-control/__tests__/ws-bridge.test.ts` — new
