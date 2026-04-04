---
title: Extract integrations and webview IPC handlers
status: done
priority: high
assignee: opus
blocked_by: [3]
---

# Extract integrations and webview IPC handlers

## 1. `electron/ipc/integrations.ts`

Move from `electron/main.ts`:
- All 10 `github:*` handlers (lines 707–770) — use `githubManager`
- All 13 `linear:*` handlers (lines 773–864) — use `linearManager`

These are straightforward pass-throughs to the manager classes.

Export: `export function register(deps: IpcDeps): void`

## 2. `electron/ipc/webview.ts`

This is the most complex IPC extraction. Move from `electron/main.ts`:

**State (lines 1053–1078):**
- `webviewRegistry: Map<string, number>` (line 1053)
- `webviewContextMenuCleanup: Map<string, () => void>` (line 1055)
- `webviewEscapeCleanup: Map<string, () => void>` (line 1056)
- `newWindowConsoleCleanup: Map<string, () => void>` (line 1057)
- `INTERCEPT_NEW_WINDOW_SCRIPT` constant (lines 1059–1078)

**Handlers (lines 1080–1294):**
- `webview:register` (line 1080) — most complex handler: sets up context menu via Menu, keyboard event forwarding (Escape, Cmd+L), new-window interception via executeJavaScript, webContents event listeners. All cleanup tracked in the three cleanup maps.
- `webview:unregister` (line 1207) — runs cleanup, removes from registry
- `webview:start-picker` (line 1219) — executes PICKER_SCRIPT in webview, sends `webview:picker-result` or `webview:picker-cancel`
- `webview:cancel-picker` (line 1258) — executes cancel script in webview
- `webview:zoom-in`, `webview:zoom-out`, `webview:zoom-reset` (lines 1269–1294)

**Key complexity:** `webview:register` uses `webContents.fromId()` to get the webview's webContents, then sets up multiple event listeners with cleanup tracking. It also accesses `getMainWindow()` to send events to the renderer.

The `webviewRegistry` and `webviewServer` are coupled — `webviewServer` is instantiated with `webviewRegistry` at line 1054. The `webviewServer` is also started in app-lifecycle. Keep `webviewRegistry` as module-level state in this file and export it so `app-lifecycle.ts` can pass it to `WebviewServer`.

Export: `export function register(deps: IpcDeps): void` and `export const webviewRegistry`

## 3. Update `electron/main.ts`

Remove extracted blocks, add imports and register calls.

## Files to touch
- `electron/ipc/integrations.ts` — CREATE
- `electron/ipc/webview.ts` — CREATE
- `electron/main.ts` — MODIFY: remove extracted handlers, add imports and register calls
