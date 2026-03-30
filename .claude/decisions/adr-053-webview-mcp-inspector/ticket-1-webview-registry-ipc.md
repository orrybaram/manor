---
title: Webview registry — IPC to track paneId→webContentsId mapping
status: done
priority: critical
assignee: sonnet
blocked_by: []
---

# Webview registry — IPC to track paneId→webContentsId mapping

The main process needs to know which `webContents` belongs to which browser pane. Add IPC handlers and renderer-side registration.

## Implementation

### Main process (`electron/main.ts`)

Add a `Map<string, number>` called `webviewRegistry` that maps paneId to webContentsId.

Add two IPC handlers:
- `webview:register(paneId: string, webContentsId: number)` — stores the mapping
- `webview:unregister(paneId: string)` — removes the mapping

### Preload (`electron/preload.ts`)

Add a `webview` namespace to `electronAPI`:
```ts
webview: {
  register: (paneId: string, webContentsId: number) => Promise<void>,
  unregister: (paneId: string) => Promise<void>,
}
```

### Type definitions (`src/electron.d.ts`)

Add the `webview` section to the `ElectronAPI` interface.

### Renderer — BrowserPane (`src/components/BrowserPane.tsx`)

When the `<webview>` fires its `did-attach` event, read the `webContentsId` from the event and call `window.electronAPI.webview.register(paneId, webContentsId)`.

The Electron `<webview>` element exposes a `getWebContentsId()` method after it's attached. Listen for the `did-attach` event, then call `webviewRef.current.getWebContentsId()` to get the ID.

On component unmount (cleanup in useEffect), call `window.electronAPI.webview.unregister(paneId)`.

Update the `WebviewElement` interface to include `getWebContentsId(): number`.

## Files to touch
- `electron/main.ts` — add webviewRegistry map + IPC handlers
- `electron/preload.ts` — add webview namespace
- `src/electron.d.ts` — add webview types to ElectronAPI
- `src/components/BrowserPane.tsx` — register/unregister on attach/unmount
