---
title: Main-process multi-window foundation
status: in-progress
priority: critical
assignee: opus
blocked_by: []
---

# Main-process multi-window foundation

Turn the single-`mainWindow` main process into one that tracks a set of windows
and routes PTY/notification events to all of them. This is the base every other
ticket builds on. No renderer changes here, no detach logic yet — just make a
second window *possible* and correctly fed.

## Requirements

1. **Refactor `electron/window.ts`**
   - Extract the shared `BrowserWindow` config (webPreferences, window-open
     handler, zoom restore) into an internal helper so it can be reused.
   - Add `export function createDetachedWindow(windowId: string, spawnBounds?:
     { x: number; y: number; width: number; height: number }): BrowserWindow`.
     - Same `webPreferences` as the primary, plus an extra entry in
       `additionalArguments`: `--manor-detached=${windowId}` (mirror the existing
       `--manor-packaged` arg at `window.ts:89`).
     - Open at `spawnBounds` when provided; otherwise a sensible default size
       centered on the cursor's display.
     - Do **not** read or write `windowBoundsFile` / zoom persistence for
       detached windows (they are ephemeral).
     - Load the same URL/file as `createWindow` (dev server URL or
       `dist/index.html`).
   - Leave `createWindow()` behavior for the primary window unchanged.

2. **Add a window registry in `electron/app-lifecycle.ts`**
   - Track all live renderer windows in a `Set<BrowserWindow>` (e.g.
     `const rendererWindows = new Set<BrowserWindow>()`), adding on create and
     removing on `closed`.
   - Keep the existing `let mainWindow` as the **primary**; the existing
     `get mainWindow()` getter in `ipcDeps` (`app-lifecycle.ts:221`) must keep
     returning the primary so all current handlers are unaffected.
   - Expose a helper to enumerate live, non-destroyed windows (used for
     broadcast below and by ticket 2).

3. **Broadcast stream events to all windows**
   - The `backend.pty.onEvent` handler (`app-lifecycle.ts:185-206`) currently
     forwards only to `mainWindow`. Change it to iterate all live renderer
     windows, applying the same destroyed/`mainFrame`-disposed guards per window
     (`app-lifecycle.ts:186-198`). A detached window hosting a terminal pane must
     receive its `pty:*` stream events.
   - Do the same for any other place that pushes pane-scoped events to
     `mainWindow.webContents.send(...)` and would matter for a detached pane
     (audit `webview`/pane event sends). Notifications
     (`maybeSendNotification`) can remain primary-targeted for now.

## Files to touch
- `electron/window.ts` — extract shared config helper; add `createDetachedWindow`.
- `electron/app-lifecycle.ts` — window `Set` registry; broadcast `onEvent` to all
  windows; keep `mainWindow` getter = primary.

## Notes
- No detach IPC or renderer logic in this ticket — ticket 2 adds the channels
  that actually call `createDetachedWindow`.
- Verify the app still builds and the primary window behaves exactly as before.
