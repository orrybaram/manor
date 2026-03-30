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

# ADR-072: Add Webview Controls (Zoom, Refresh, URL Bar Focus, Focus Indicator)

## Context

The browser pane (webview) has basic navigation (back/forward/reload buttons, URL input) in the status bar, but lacks several controls that make it feel like a proper embedded browser:

1. **Zoom** — No way to zoom in/out within an individual webview. The existing Cmd+Plus/Minus/0 shortcuts control the *entire app* zoom via `mainWindow.webContents.setZoomFactor()`. Users need per-webview zoom.
2. **Refresh shortcut** — The reload button exists in the toolbar, but there's no Cmd+R keyboard shortcut for it.
3. **URL bar focus** — No Cmd+L shortcut to focus the URL bar (standard browser behavior).
4. **Focus indicator** — There's a `.webviewFocused` class that adds a 2px accent border-top, but it's subtle. The "Esc Esc to exit" hint only shows on focus transitions. The status bar itself doesn't visually change when the webview captures input.

All of these should only apply when a browser pane is active/focused, not when a terminal pane is focused.

## Decision

### Zoom (per-webview)

Add IPC methods `webview:zoom-in`, `webview:zoom-out`, `webview:zoom-reset` that call `webContents.setZoomLevel()` on the specific webview's `webContents` (not the main window). This gives per-pane zoom independent of the app zoom.

- Main process: Add three IPC handlers that look up `webContentsId` from `webviewRegistry` and call `wc.setZoomLevel()` on that specific webContents.
- Preload: Expose `webview.zoomIn(paneId)`, `webview.zoomOut(paneId)`, `webview.zoomReset(paneId)`.
- Renderer: In `BrowserPane`, expose `zoomIn()`, `zoomOut()`, `zoomReset()` via the imperative ref. In `LeafPane`, add zoom buttons (ZoomIn/ZoomOut icons) to the browser nav controls.
- Keyboard: Add `browser-zoom-in` (Cmd+=), `browser-zoom-out` (Cmd+-), `browser-zoom-reset` (Cmd+0) keybindings. These need special handling: they should only fire when the focused pane is a browser pane. The App.tsx handler will check `paneContentType[focusedPaneId]` and if it's `"browser"`, call the browser zoom action; otherwise let the event propagate to the native menu handler (app zoom). This is done by NOT calling `e.preventDefault()` when the focused pane is not a browser.

### Refresh shortcut

Add a `browser-reload` keybinding (Cmd+R). Same conditional logic: only fire when the focused pane is a browser pane, otherwise don't intercept (so terminal Ctrl+R still works).

### URL bar focus (Cmd+L)

Add a `browser-focus-url` keybinding (Cmd+L). When triggered, focus the URL input in LeafPane for the active browser pane. This requires the BrowserPaneRef.focusUrlInput() method to actually call `urlInputRef.current?.focus()` — currently it's a no-op placeholder. Since the URL input lives in LeafPane, we need LeafPane to pass a `setUrlInputRef` callback into BrowserPane, or have the App.tsx handler directly find and focus the input element via a data attribute.

Approach: Add a `data-pane-url-input={paneId}` attribute to the URL input in LeafPane. The App.tsx handler for `browser-focus-url` will query `document.querySelector(`[data-pane-url-input="${focusedPaneId}"]`)` and focus it.

### Focus indicator

Enhance the visual feedback when the webview is focused:
- Status bar background changes to use accent color at low opacity when webview is focused (indicating the webview is capturing input).
- The existing 2px border-top accent on the webview container is sufficient; the status bar change makes it more obvious.

## Consequences

- **Better**: The browser pane feels much more like a real browser with standard shortcuts.
- **Tradeoff**: Cmd+Plus/Minus/0 now has dual behavior depending on focused pane type. This matches user expectation (zoom the thing I'm looking at) but could surprise users who expect app-wide zoom when a browser is focused.
- **Risk**: The conditional shortcut routing adds complexity to the keydown handler in App.tsx. We need to be careful that the native menu zoom still works when no browser is focused.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
