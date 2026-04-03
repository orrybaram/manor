---
title: Wire updater IPC in main and preload
status: done
priority: high
assignee: sonnet
blocked_by: [2]
---

# Wire updater IPC in main and preload

## Main process (electron/main.ts)

1. Import `initAutoUpdater`, `checkForUpdates`, `quitAndInstall` from `./updater`
2. Add IPC handlers:
   - `ipcMain.handle("updater:checkForUpdates", () => checkForUpdates())`
   - `ipcMain.handle("updater:quitAndInstall", () => quitAndInstall())`
3. Call `initAutoUpdater(mainWindow)` inside `app.whenReady()` after window creation (after `createWindow()`)

## Preload (electron/preload.ts)

Add an `updater` section to the exposed API:

```ts
updater: {
  checkForUpdates: () => ipcRenderer.invoke("updater:checkForUpdates"),
  quitAndInstall: () => ipcRenderer.invoke("updater:quitAndInstall"),
  onUpdateAvailable: (callback: (info: { version: string }) => void) =>
    onChannel("updater:update-available", callback),
  onUpdateDownloaded: (callback: (info: { version: string }) => void) =>
    onChannel("updater:update-downloaded", callback),
  onDownloadProgress: (callback: (progress: { percent: number; bytesPerSecond: number; transferred: number; total: number }) => void) =>
    onChannel("updater:download-progress", callback),
  onError: (callback: (message: string) => void) =>
    onChannel("updater:error", callback),
},
```

## Files to touch
- `electron/main.ts` — import updater, add IPC handlers, call init
- `electron/preload.ts` — expose updater API to renderer
