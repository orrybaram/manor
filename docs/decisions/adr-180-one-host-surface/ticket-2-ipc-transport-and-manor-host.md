---
title: The IPC transport and the preload's host object
status: done
priority: critical
assignee: opus
blocked_by: [1]
---

# The IPC transport and the preload's host object

ADR-180 D2/D3. Give the bridge a second transport — Electron IPC — and give
the preload the one concrete object the page builds its proxy over. At the end
of this ticket the desktop still runs entirely on its existing preload
namespaces; nothing has migrated yet. This ticket only makes the road.

## `electron/bridge/transports/ipc.ts`

Four channels, and no others ever:

| channel | direction | payload |
| --- | --- | --- |
| `bridge:invoke` | `ipcMain.handle` | `{ns, method, args}` → the result, or a rejection carrying `code` |
| `bridge:subscribe` | `ipcMain.on` | `{ns, event, key?}` |
| `bridge:unsubscribe` | `ipcMain.on` | `{ns, event, key?}` |
| `bridge:event` | `webContents.send` | `{ns, event, key?, args}` |

One `BridgeConnection` per renderer window, created lazily on that window's
first frame and dropped on its `destroyed` event:

- `id` = `String(webContents.id)` — which is already what `rendererId` is on
  the desktop (`src/electron.d.ts`), so layout origins and viewport reports
  keep naming the same thing they name today.
- `callerClass: "local"`, `deviceId: null`.
- `send(frame)` = `webContents.send("bridge:event", frame)`, guarded on
  `isDestroyed()`.

**Sender validation (D2, security-critical).** Every frame's `event.sender`
must be the `webContents` of a window in `deps.getRendererWindows()` or a
registered detached window. Anything else — a `<webview>` guest above all — is
dropped with a `console.warn` and no reply. Write this as one exported
predicate with a comment naming `<webview>`, and give it a unit test.

An invoke rejection must carry the code the renderer needs to distinguish an
unavailable method from a real failure. `ipcMain.handle` rejections lose
custom properties, so serialise: return `{__bridgeError: {code, message}}` and
let the client throw, or throw an `Error` whose `message` is prefixed with the
code and parse it — pick the first, it is honest.

## `electron/preload.ts`

Expose a second global next to the existing `electronAPI` (which stays intact
this ticket — later tickets hollow it out):

```ts
contextBridge.exposeInMainWorld("manorHost", {
  platform: "electron",
  rendererId, isDetached, detachedWindowId, claim, env: { isPackaged },
  invoke: (ns, method, args) => ipcRenderer.invoke("bridge:invoke", { ns, method, args }),
  subscribe: (ns, event, key, callback) => { … },   // returns the unsubscribe
});
```

`subscribe` keeps one `ipcRenderer.on("bridge:event", …)` listener for the
whole page and fans out locally by `ns`/`event`/`key`, sending
`bridge:subscribe` on the first listener for a pair and `bridge:unsubscribe`
on the last removal. Reference-count it; a pane that mounts twice in React
StrictMode must not unsubscribe the live one.

Declare `manorHost` in `src/electron.d.ts` on `Window` as
`ManorHost | undefined` (undefined in a browser), with `ManorHost`'s `invoke`
typed `(ns: string, method: string, args: unknown[]) => Promise<unknown>`.

## Verification

Add `electron/bridge/__tests__/ipc-transport.test.ts`: a fake `ipcMain`/
`webContents` proving (a) an invoke from a known window dispatches, (b) an
invoke from an unknown sender is dropped, (c) subscribe/unsubscribe
reference-counting, (d) a destroyed window's connection is dropped.

## Files to touch
- `electron/bridge/transports/ipc.ts` — new; the four channels, the connection per window, the sender predicate
- `electron/preload.ts` — add `manorHost`; leave `electronAPI` untouched
- `electron/app-lifecycle.ts` — start the IPC transport with the `BridgeServer` from ticket 1
- `src/electron.d.ts` — `ManorHost` type and the `Window` declaration
- `electron/bridge/__tests__/ipc-transport.test.ts` — new
