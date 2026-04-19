---
type: adr
status: accepted
database:
  schema:
    status:
      type: select
      options: [todo, in-progress, review, done]
      default: todo
    priority:
      type: select
      options: [critical, high, medium, low]
    assignee:
      type: select
      options: [opus, sonnet, haiku]
  defaultView: board
  groupBy: status
---

# ADR-122: Add right-click "Inspect Element" context menu to webviews

## Context

Browser tab webviews (`<webview>` tags in BrowserPane) have no way to open Chrome DevTools for the guest page. The main window's `toggleDevTools` menu item only opens DevTools for the main renderer process, not for individual webview guest contents. Developers need to inspect webview pages during development.

## Decision

Add a `context-menu` event listener to each webview's `webContents` in the main process. When a webview is registered via the `webview:register` IPC handler, we'll attach the listener using `webContents.fromId()`. The context menu will show a single "Inspect Element" item that calls `webContents.inspectElement(x, y)` at the click coordinates.

The listener will be cleaned up when the webview is unregistered via `webview:unregister`.

Implementation in `electron/main.ts`:
- Store context-menu listener references in a map alongside the existing `webviewRegistry`
- In `webview:register`: get the `webContents` via `webContents.fromId()`, attach `context-menu` listener that builds a `Menu` with "Inspect Element"
- In `webview:unregister`: remove the listener

## Consequences

- Developers can right-click any webview and inspect elements with full Chrome DevTools
- Minimal code change — ~20 lines in `electron/main.ts`
- No renderer-side changes needed; context-menu is handled entirely in the main process
- The context menu appears on all webviews, including in production builds — acceptable since this is a developer tool (Manor itself)

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
