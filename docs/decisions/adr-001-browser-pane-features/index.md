---
type: adr
status: proposed
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

# ADR-001: Add Missing Browser Pane Features

## Context

The BrowserPane is functional for basic navigation but lacks several standard browser features that users expect. The toolbar has back/forward/reload buttons, URL bar with history autocomplete, element picker, and zoom controls. Missing are: loading state feedback, favicon display, SSL indicator, find-in-page, back/forward keyboard shortcuts, stop-loading, and search engine fallback for non-URL input.

## Decision

Add 7 features to BrowserPane, grouped into 3 implementation tickets:

**Ticket 1 — Main process IPC foundation** (electron side):
- Add `webview:stop` IPC handler to call `wc.stop()`
- Add `webview:find-in-page` and `webview:stop-find-in-page` IPC handlers using Electron's `wc.findInPage()` / `wc.stopFindInPage()`
- Send `webview:loading-changed` events to renderer by listening to `did-start-loading` / `did-stop-loading` on registered webContents
- Send `webview:favicon-updated` events by listening to `page-favicon-updated`
- Add `Cmd+F` interception in the `before-input-event` handler to send `webview:find` to renderer
- Add `Cmd+[` / `Cmd+]` interception to send `webview:go-back` / `webview:go-forward` to renderer
- Wire all new IPC channels in `preload.ts` and type them in `electron.d.ts`

**Ticket 2 — BrowserPane state & logic** (renderer):
- Add `isLoading`, `isSecure`, `favicon` fields to `BrowserPaneNavState`
- Add `findBarOpen`, `findQuery`, `findMatches`, `findActiveMatch` fields for find-in-page state
- Listen to new IPC events: `webview:loading-changed`, `webview:favicon-updated`, `webview:find`, `webview:go-back`, `webview:go-forward`
- Add `stop()`, `findInPage(query)`, `stopFind()`, `toggleFindBar()` methods to `BrowserPaneRef`
- Derive `isSecure` from URL (starts with `https://`)
- Modify `navigateTo()`: if input doesn't look like a URL (no dots, no protocol, no localhost pattern), redirect to `https://www.google.com/search?q=...`
- Add `browser-back`, `browser-forward`, `browser-find` keybinding definitions

**Ticket 3 — LeafPane toolbar UI**:
- Swap reload button for stop button when `isLoading` is true (use `X` icon for stop, `RotateCw` for reload)
- Show a 2px accent-colored loading bar at the top of the webview container when `isLoading`
- Show favicon as a 12x12 `<img>` before the URL input (fall back to a globe icon)
- Show a lock icon before the favicon when `isSecure`, a warning icon when not
- Render a find-in-page bar (input + match count + prev/next/close buttons) below the status bar when `findBarOpen`

## Consequences

**Better**: Users get visual feedback during loading, can identify secure sites, search the web from the URL bar, use Cmd+F to find text, and navigate with keyboard shortcuts.

**Risk**: Favicon URLs come from the page and are loaded as `<img src>` — these are sandboxed within the renderer and pose no injection risk. Find-in-page uses Electron's built-in `findInPage` API which handles highlighting natively.

**Tradeoff**: SSL indicator is URL-based (`https://` check) rather than certificate-based. This is simpler but doesn't catch mixed content or invalid certs. Acceptable for a dev tool browser.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
