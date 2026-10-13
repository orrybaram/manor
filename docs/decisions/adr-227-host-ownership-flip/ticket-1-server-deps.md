---
title: Split HostDeps into window-free ServerDeps and DesktopDeps
status: todo
priority: critical
assignee: opus
blocked_by: []
---

# Split HostDeps into window-free ServerDeps and DesktopDeps

ADR-227 D1. This ticket is a pure refactor: no behavior changes.

`HostDeps` (`electron/ipc/types.ts:52`) carries `BrowserWindow`,
`getRendererWindows`, `registerDetachedWindow`, `webviewServer` and `appMenu`.
Every handler in `electron/bridge/handlers/*` is typed over it, so no handler
can be shared with the host server.

## Do
- Define `ServerDeps` (window-free) and `DesktopDeps` (windows, menu, webview
  server, detached windows) in `electron/ipc/types.ts`. Make
  `HostDeps = ServerDeps & DesktopDeps`.
- Retype each handler over the **narrowest** deps it uses. Handlers that only
  touch managers take `ServerDeps` (or a `Pick`). Desktop-only namespaces
  (window, menu, webview, native, dialog, shell, clipboard, updater) keep
  `HostDeps`.
- Split `electron/bridge/handlers.ts` into:
  - `SERVER_METHODS`, typed over `ServerDeps`;
  - `DESKTOP_METHODS`, the desktop-only namespaces.
  
  `DESKTOP_TABLE` is built from both. The `Handlers` type (contract.ts) must
  not change shape.
- Remove the runtime Electron imports that the shared handlers drag in:
  - `bridge/handlers/preferences.ts` imports `playNotificationSound` from
    `notifications.ts`.
  - `bridge/handlers/app-commands.ts` imports `appCommandResult` from
    `renderer-bridge.ts`.
  
  Reach both through new `ServerDeps` fields (`playSound?`,
  `appCommandResult?`) that the desktop fills in.
- Add a unit test that bundles `SERVER_METHODS` with esbuild, in the same
  style as `electron/platform/__tests__/electron-free.test.ts`, and asserts
  that no `electron` import is present.

## Files to touch
- `electron/ipc/types.ts`: define `ServerDeps` and `DesktopDeps`.
- `electron/bridge/handlers.ts`: split into `SERVER_METHODS` and
  `DESKTOP_METHODS`.
- `electron/bridge/handlers/*.ts`: retype the handlers.
- `electron/bridge/handlers/preferences.ts`,
  `electron/bridge/handlers/app-commands.ts`: remove the Electron imports.
- `electron/app-lifecycle.ts`: fill in the new deps fields.
- `electron/platform/__tests__/electron-free.test.ts`: add the
  `SERVER_METHODS` bundle check.
