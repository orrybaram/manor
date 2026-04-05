---
title: Add main process IPC handlers for new browser features
status: in-progress
priority: high
assignee: sonnet
blocked_by: []
---

# Add main process IPC handlers for new browser features

Add IPC infrastructure in the Electron main process for: stop loading, find-in-page, loading state, favicon, and back/forward keyboard shortcuts.

## Implementation

### 1. `electron/ipc/webview.ts` — New IPC handlers

**Stop loading:**
```typescript
ipcMain.handle("webview:stop", (_event, paneId: string) => {
  assertString(paneId, "paneId");
  const webContentsId = webviewRegistry.get(paneId);
  if (!webContentsId) return;
  const wc = webContents.fromId(webContentsId);
  if (!wc || wc.isDestroyed()) return;
  wc.stop();
});
```

**Find-in-page:**
```typescript
ipcMain.handle("webview:find-in-page", (_event, paneId: string, query: string, options?: { forward?: boolean; findNext?: boolean }) => {
  assertString(paneId, "paneId");
  const webContentsId = webviewRegistry.get(paneId);
  if (!webContentsId) return;
  const wc = webContents.fromId(webContentsId);
  if (!wc || wc.isDestroyed()) return;
  wc.findInPage(query, options);
});

ipcMain.handle("webview:stop-find-in-page", (_event, paneId: string) => {
  assertString(paneId, "paneId");
  const webContentsId = webviewRegistry.get(paneId);
  if (!webContentsId) return;
  const wc = webContents.fromId(webContentsId);
  if (!wc || wc.isDestroyed()) return;
  wc.stopFindInPage("clearSelection");
});
```

**Inside the `webview:register` handler**, after the existing `wc.on("before-input-event", escapeHandler)` block, add loading/favicon/find event listeners:

**Loading state** — listen on `did-start-loading` and `did-stop-loading`:
```typescript
const loadingStartHandler = () => {
  rendererWebContents.send("webview:loading-changed", paneId, true);
};
const loadingStopHandler = () => {
  rendererWebContents.send("webview:loading-changed", paneId, false);
};
wc.on("did-start-loading", loadingStartHandler);
wc.on("did-stop-loading", loadingStopHandler);
```

**Favicon** — listen on `page-favicon-updated`:
```typescript
const faviconHandler = (_ev: Electron.Event, favicons: string[]) => {
  if (favicons.length > 0) {
    rendererWebContents.send("webview:favicon-updated", paneId, favicons[0]);
  }
};
wc.on("page-favicon-updated", faviconHandler);
```

**Find results** — listen on `found-in-page`:
```typescript
const findResultHandler = (_ev: Electron.Event, result: Electron.FoundInPageResult) => {
  rendererWebContents.send("webview:find-result", paneId, {
    activeMatchOrdinal: result.activeMatchOrdinal,
    matches: result.matches,
    finalUpdate: result.finalUpdate,
  });
};
wc.on("found-in-page", findResultHandler);
```

**Add `Cmd+F`, `Cmd+[`, `Cmd+]`** to the existing `escapeHandler` (the `before-input-event` handler), inside the `if (input.meta && !input.alt && !input.control && !input.shift)` block:
```typescript
} else if (input.key === "f") {
  ev.preventDefault();
  rendererWebContents.send("webview:find", paneId);
} else if (input.key === "[") {
  ev.preventDefault();
  rendererWebContents.send("webview:go-back", paneId);
} else if (input.key === "]") {
  ev.preventDefault();
  rendererWebContents.send("webview:go-forward", paneId);
}
```

**Cleanup** — add all new listeners to a cleanup map (extend `newWindowConsoleCleanup` or create a new one). In the unregister handler, call the cleanup:
```typescript
wc.off("did-start-loading", loadingStartHandler);
wc.off("did-stop-loading", loadingStopHandler);
wc.off("page-favicon-updated", faviconHandler);
wc.off("found-in-page", findResultHandler);
```

### 2. `electron/preload.ts` — Bridge new IPC channels

Add to the `webview` object in `contextBridge.exposeInMainWorld`:
```typescript
stop: (paneId: string) => ipcRenderer.invoke("webview:stop", paneId),
findInPage: (paneId: string, query: string, options?: { forward?: boolean; findNext?: boolean }) =>
  ipcRenderer.invoke("webview:find-in-page", paneId, query, options),
stopFindInPage: (paneId: string) =>
  ipcRenderer.invoke("webview:stop-find-in-page", paneId),
onLoadingChanged: (callback: (paneId: string, isLoading: boolean) => void) =>
  onChannel("webview:loading-changed", callback),
onFaviconUpdated: (callback: (paneId: string, faviconUrl: string) => void) =>
  onChannel("webview:favicon-updated", callback),
onFindResult: (callback: (paneId: string, result: { activeMatchOrdinal: number; matches: number; finalUpdate: boolean }) => void) =>
  onChannel("webview:find-result", callback),
onFind: (callback: (paneId: string) => void) =>
  onChannel("webview:find", callback),
onGoBack: (callback: (paneId: string) => void) =>
  onChannel("webview:go-back", callback),
onGoForward: (callback: (paneId: string) => void) =>
  onChannel("webview:go-forward", callback),
```

### 3. `src/electron.d.ts` — Type the new APIs

Add to the `webview` interface in `ElectronAPI`:
```typescript
stop: (paneId: string) => Promise<void>;
findInPage: (paneId: string, query: string, options?: { forward?: boolean; findNext?: boolean }) => Promise<void>;
stopFindInPage: (paneId: string) => Promise<void>;
onLoadingChanged: (callback: (paneId: string, isLoading: boolean) => void) => () => void;
onFaviconUpdated: (callback: (paneId: string, faviconUrl: string) => void) => () => void;
onFindResult: (callback: (paneId: string, result: { activeMatchOrdinal: number; matches: number; finalUpdate: boolean }) => void) => () => void;
onFind: (callback: (paneId: string) => void) => () => void;
onGoBack: (callback: (paneId: string) => void) => () => void;
onGoForward: (callback: (paneId: string) => void) => () => void;
```

## Files to touch
- `electron/ipc/webview.ts` — Add stop/find IPC handlers, loading/favicon/find event listeners inside register, keyboard shortcut interception, cleanup
- `electron/preload.ts` — Bridge all new IPC channels
- `src/electron.d.ts` — Type declarations for new webview APIs
