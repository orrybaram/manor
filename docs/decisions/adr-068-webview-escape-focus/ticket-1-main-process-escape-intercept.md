---
title: Double-tap Escape intercept via before-input-event
status: done
priority: critical
assignee: sonnet
blocked_by: []
---

# Double-tap Escape intercept via before-input-event

In `electron/main.ts`, inside the `webview:register` IPC handler, add a `before-input-event` listener on the webview's `webContents` that implements double-tap Escape detection.

## Double-tap logic

Track a `lastEscapeTime` per webview (or per the single listener, scoped to the paneId):

1. On `before-input-event` where `input.key === 'Escape'` and `input.type === 'keyDown'` and no modifiers:
   - If `Date.now() - lastEscapeTime < 500`: this is a double-tap
     - Call `event.preventDefault()` to stop the second Escape from reaching the page
     - Send `webview:escape` IPC to the parent BrowserWindow's webContents with the `paneId`
     - Reset `lastEscapeTime` to 0
   - Else: record `lastEscapeTime = Date.now()` and let the event pass through (don't preventDefault)

## Finding the parent window

Use `BrowserWindow.fromWebContents(wc)` or `BrowserWindow.getAllWindows()[0]` (Manor is single-window) to get the renderer's webContents to send the IPC event to. Alternatively, `_event.sender` from the original `webview:register` call refers to the renderer — store a reference to it.

Actually, the simplest approach: store the renderer `webContents` from the `_event.sender` in the register handler and use `rendererWebContents.send('webview:escape', paneId)` to notify the renderer.

## Cleanup

Store the `before-input-event` handler reference and remove it in `webview:unregister`, similar to the existing context-menu cleanup pattern using `webviewContextMenuCleanup`.

## Preload additions

In `electron/preload.ts`, expose:
- `webview.onEscape(callback: (paneId: string) => void): () => void` — uses `onChannel('webview:escape', callback)`

## Type additions

In `src/electron.d.ts`, add to the `webview` section of `ElectronAPI`:
- `onEscape: (callback: (paneId: string) => void) => () => void`

## Files to touch
- `electron/main.ts` — add `before-input-event` listener with double-tap logic in `webview:register`, cleanup in `webview:unregister`
- `electron/preload.ts` — add `webview.onEscape`
- `src/electron.d.ts` — add type for `onEscape`
