---
title: Create updater module in main process
status: done
priority: high
assignee: sonnet
blocked_by: [1]
---

# Create updater module in main process

Create `electron/updater.ts` that wraps `electron-updater` and forwards status to the renderer.

## Requirements

- Import `autoUpdater` from `electron-updater`
- Export a function `initAutoUpdater(win: BrowserWindow)` that:
  - Sets `autoUpdater.autoDownload = true`
  - Sets `autoUpdater.autoInstallOnAppQuit = true`
  - Listens to autoUpdater events and forwards them to the renderer via `win.webContents.send()`:
    - `update-available` → send `"updater:update-available"` with version info
    - `update-downloaded` → send `"updater:update-downloaded"` with version info
    - `error` → send `"updater:error"` with error message string
    - `download-progress` → send `"updater:download-progress"` with `{ percent, bytesPerSecond, transferred, total }`
  - Calls `autoUpdater.checkForUpdates()` after a 5-second delay (don't block startup)
  - Guard the check in a try/catch — in dev mode or without code signing, this will fail silently
- Export a function `checkForUpdates()` that calls `autoUpdater.checkForUpdates()`
- Export a function `quitAndInstall()` that calls `autoUpdater.quitAndInstall()`

## Files to touch
- `electron/updater.ts` — new file
