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

# ADR-094: Block webview pointer events during drag operations

## Context

When dragging panes, tabs, splitter dividers, or workspace items, moving the pointer over a `<webview>` element causes the drag to break. The webview is a separate browsing context (like an iframe) that captures pointer events, preventing the parent document from receiving `pointermove`/`pointerup` — so the drag silently dies.

There are four independent drag sources in the app:
1. **Pane drag** — `LeafPane.handleStatusBarPointerDown` → `PaneDragContext`
2. **Tab drag** — `TabBar.handleDragStart` → `PaneDragContext`
3. **Splitter drag** — `SplitLayout.handleMouseDown` → local `isDragging` state
4. **Workspace drag** — `useWorkspaceDrag` → local `dragIndex` state

All four can move the pointer over a browser pane and get interrupted.

## Decision

Add a lightweight global drag-active signal and use it to overlay webviews during any drag operation.

**1. Create a `drag-overlay-store.ts` Zustand store** with a simple counter-based API:
- `incrementDragCount()` — called when any drag starts
- `decrementDragCount()` — called when any drag ends
- `isDragActive` — derived boolean (`count > 0`)

A counter (not a boolean) handles edge cases where multiple drag sources could theoretically overlap without miscounting.

**2. Wire each drag source** to call `incrementDragCount`/`decrementDragCount`:
- `PaneDragContext` — in `startDrag`/`endDrag`
- `SplitLayout` — in `handleMouseDown` start/cleanup
- `useWorkspaceDrag` — in drag activation/cleanup

**3. In `BrowserPane`**, subscribe to `isDragActive` and conditionally render a transparent overlay `<div>` on top of the `<webview>` (or apply `pointer-events: none` to the webview). The overlay is invisible but blocks the webview from capturing events.

### Why an overlay instead of `pointer-events: none` on the webview?

Both work, but an overlay is more reliable across Electron versions. Some versions have quirks where `pointer-events: none` on a `<webview>` tag doesn't fully suppress event forwarding to the guest process. A plain `<div>` overlay has no such issues.

## Consequences

- **Fixes**: All drag operations (pane, tab, splitter, workspace) now work smoothly over browser panes.
- **Tradeoff**: During a drag, the webview won't receive hover effects — acceptable since the user is mid-drag.
- **Risk**: Minimal. The overlay only appears during active drags and is automatically removed.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
