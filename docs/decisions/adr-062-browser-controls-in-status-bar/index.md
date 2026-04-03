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

# ADR-062: Move browser controls into pane status bar

## Context

Browser panes currently render their own toolbar (back/forward/reload/URL input/pick element) as a separate bar below the pane status bar. This means browser panes have two bars stacked: the status bar (title + split/close) and the browser toolbar. Additionally, session tabs for browser panes show the page title (or "Terminal" if no title is set yet), but users want to see the URL instead.

## Decision

1. **Merge browser toolbar into the pane status bar**: When a pane's content type is "browser", replace the title text in the status bar with the browser navigation controls (back, forward, reload, URL input, pick element). The split/close buttons remain at the right end.

2. **Show URL in session tabs for browser panes**: Update `useSessionTitle` to fall back to `paneUrl` for browser content types instead of showing "Terminal".

3. **Implementation approach**: Extract browser navigation logic into a `useBrowserNav` hook so LeafPane can render the controls in its status bar. BrowserPane exposes a ref with navigation methods via `useImperativeHandle`. BrowserPane no longer renders its own toolbar.

## Consequences

- Browser panes get a cleaner single-bar layout matching terminal panes
- Tab titles become more useful for browser panes (showing URL)
- BrowserPane becomes simpler (just webview + empty state)
- LeafPane gets more complex with conditional browser controls rendering

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
