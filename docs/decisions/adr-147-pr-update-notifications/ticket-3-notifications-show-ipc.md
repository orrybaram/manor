---
title: Add notifications:show IPC for renderer
status: done
priority: high
assignee: sonnet
blocked_by: [2]
---

# Add notifications:show IPC for renderer

Add a main-process handler that lets the renderer fire a native macOS
notification on demand, mirroring `maybeSendNotification` in
`electron/notifications.ts`.

Behavior:
- Input: `{ title: string; body: string; url?: string }`.
- Only show when the main window is NOT focused (`mainWindow.isFocused()` →
  return early). This keeps native alerts to when the app is backgrounded; the
  renderer shows a toast when focused.
- Build `new Notification({ title, body, silent: true })`.
- On click: `mainWindow.show()`, `mainWindow.focus()`, and if `url` is present
  `shell.openExternal(url)`.
- After showing, play the configured sound if set: read
  `preferencesManager.get("notificationSound")`; if it is a string, run
  `execFile("afplay", [\`/System/Library/Sounds/${soundName}.aiff\`])`.

## Files to touch

- `electron/notifications.ts`
  - Add an exported helper, e.g.
    `showPrNotification(payload, mainWindow, preferencesManager)`, implementing
    the behavior above. Reuse imports already present (`Notification`,
    `execFile`); add `shell` from `electron`.

- `electron/ipc/misc.ts` (or wherever `IpcDeps` exposes `preferencesManager` +
  a way to get the main window — check how `preferences-changed` uses
  `getMainWindow()` in this same file and reuse it)
  - Register `ipcMain.handle("notifications:show", (_e, payload) => { ... })`
    calling the helper with `getMainWindow()` and `preferencesManager`.
  - Validate `payload.title` / `payload.body` are strings (use `assertString`).

- `electron/preload.ts`
  - Under the existing `notifications` object (around line 406), add
    `show: (payload) => ipcRenderer.invoke("notifications:show", payload)`.

- `src/electron.d.ts`
  - Add to the `notifications` type (around line 585):
    `show: (payload: { title: string; body: string; url?: string }) => Promise<void>;`

## Notes
- Match the existing focus-suppression and silent-notification conventions in
  `maybeSendNotification`.
