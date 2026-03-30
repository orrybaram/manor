---
title: Add per-webview zoom IPC handlers
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Add per-webview zoom IPC handlers

Add IPC plumbing for per-webview zoom control: main process handlers, preload bridge, and type definitions.

## Implementation

### Main process (`electron/main.ts`)

Add three IPC handlers after the existing webview handlers (~line 1021):

```typescript
ipcMain.handle("webview:zoom-in", (_event, paneId: string) => {
  assertString(paneId, "paneId");
  const webContentsId = webviewRegistry.get(paneId);
  if (!webContentsId) return;
  const wc = webContents.fromId(webContentsId);
  if (!wc || wc.isDestroyed()) return;
  wc.setZoomLevel(Math.min(wc.getZoomLevel() + 0.5, 5));
});

ipcMain.handle("webview:zoom-out", (_event, paneId: string) => {
  assertString(paneId, "paneId");
  const webContentsId = webviewRegistry.get(paneId);
  if (!webContentsId) return;
  const wc = webContents.fromId(webContentsId);
  if (!wc || wc.isDestroyed()) return;
  wc.setZoomLevel(Math.max(wc.getZoomLevel() - 0.5, -3));
});

ipcMain.handle("webview:zoom-reset", (_event, paneId: string) => {
  assertString(paneId, "paneId");
  const webContentsId = webviewRegistry.get(paneId);
  if (!webContentsId) return;
  const wc = webContents.fromId(webContentsId);
  if (!wc || wc.isDestroyed()) return;
  wc.setZoomLevel(0);
});
```

### Preload (`electron/preload.ts`)

Add to the `webview` object:

```typescript
zoomIn: (paneId: string) => ipcRenderer.invoke("webview:zoom-in", paneId),
zoomOut: (paneId: string) => ipcRenderer.invoke("webview:zoom-out", paneId),
zoomReset: (paneId: string) => ipcRenderer.invoke("webview:zoom-reset", paneId),
```

### Types (`src/electron.d.ts`)

Add to the `webview` interface:

```typescript
zoomIn: (paneId: string) => Promise<void>;
zoomOut: (paneId: string) => Promise<void>;
zoomReset: (paneId: string) => Promise<void>;
```

## Files to touch
- `electron/main.ts` — Add three IPC handlers for zoom
- `electron/preload.ts` — Bridge zoom methods to renderer
- `src/electron.d.ts` — Add type definitions for zoom methods
