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

# ADR-074: Fix browser keybinds when webview is focused

## Context

When a browser pane's webview has focus, keyboard events are consumed by the webview's `webContents` and never reach the renderer's `window` keydown handler in App.tsx. This means Cmd+/- (zoom), Cmd+R (reload), and Cmd+L (focus URL bar) don't work when the user is interacting with the browser content.

The existing `before-input-event` handler on webview webContents already intercepts Escape for the double-press blur behavior. The same mechanism can intercept browser keybindings.

## Decision

Extend the `before-input-event` handler in `electron/main.ts` (inside `webview:register`) to intercept browser keybindings when the webview has focus:

- **Cmd+=** / **Cmd+-** / **Cmd+0**: Handle zoom directly in main process using the existing `wc.setZoomLevel()` calls (same logic as the IPC handlers)
- **Cmd+R**: Call `wc.reload()` directly
- **Cmd+L**: Send a new IPC message `webview:focus-url` to the renderer, which focuses and selects the URL bar input (same as `browser-focus-url` handler in App.tsx)

All intercepted keys call `ev.preventDefault()` to stop them from reaching the embedded page.

The keybinding definitions are hardcoded in main process rather than dynamically read from the keybindings store, since user-customized keybindings would require syncing the store to main process. The defaults match the `browser-*` keybindings in `keybindings.ts`.

## Consequences

- Browser zoom, reload, and URL focus work correctly when the webview has focus
- Keys are prevented from reaching the embedded page (e.g., Cmd+R won't trigger the page's own reload handler)
- Custom keybinding overrides for browser commands won't apply when the webview is focused (acceptable tradeoff — users rarely rebind these)

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
