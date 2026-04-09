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

# ADR-115: Webview Host — Stable Browser Panes Across Splits

## Context

When a user splits a pane containing a browser, the browser reloads and loses all state (scroll position, form data, navigation history). This happens because splitting transforms the pane tree from a leaf node into a split node, which completely changes the React component hierarchy. React unmounts the old `LeafPane` (and its `<webview>` child) and mounts a fresh one at a new position in the tree. Electron's `<webview>` element is destroyed when unmounted, wiping all web content state.

The same issue occurs during any tree restructuring: pane moves, drag-and-drop reorder, and closing a sibling pane that collapses a split.

## Decision

Adopt a **webview host pattern**: render all `<webview>` elements in a single stable container outside the pane tree, and position them as absolute overlays on top of their pane slots using DOM rect measurements.

### Architecture

1. **`WebviewHost`** — A new component rendered inside `PaneDragProvider` (in `App.tsx`) but outside the `PanelLayout` tree. It owns all `<webview>` elements and never unmounts them due to tree restructuring. Each webview is keyed by its `paneId`.

2. **`WebviewSlot`** — A lightweight placeholder rendered by `LeafPane` where the browser content would normally go. It measures its own bounding rect via `ResizeObserver` and reports it to a shared store so `WebviewHost` can position the corresponding webview on top.

3. **`webview-host-store.ts`** — A small Zustand store that maps `paneId → { rect, visible }`. `WebviewSlot` writes rects; `WebviewHost` reads them to position webviews. This decouples the two without prop drilling.

4. **`BrowserPane`** stays mostly unchanged — it still manages webview event listeners, navigation state, and the imperative ref. It just moves from being rendered inside `LeafPane` to being rendered inside `WebviewHost`.

### Rendering flow

```
App
├── PaneDragProvider
│   ├── main-content
│   │   ├── PanelLayout → LeafPanel → PaneLayout → LeafPane
│   │   │   └── WebviewSlot (measures rect, renders empty div)
│   │   └── StatusBar
│   └── WebviewHost (absolute positioned container)
│       └── BrowserPane (per pane, positioned via slot rects)
```

When a split happens, the pane tree restructures but `WebviewHost` doesn't re-render its children — the `paneId` is stable and the webview stays mounted. Only the slot's rect changes, which updates the webview's CSS position.

### Visibility

- Active tab + visible pane: webview positioned over slot, `visibility: visible`
- Hidden tab or non-active workspace: `visibility: hidden` (matches existing `TAB_HIDDEN_STYLE` pattern)
- Pane being dragged: `visibility: hidden` while drag is active

### Integration with existing systems

- `browser-pane-registry.ts` continues to work unchanged — it registers by `paneId`
- The `LeafPane` status bar (nav controls, URL input, find bar) stays in `LeafPane` and communicates with `BrowserPane` via the existing ref pattern
- Drag overlay for webviews is handled by the host (absolute div over the webview when `isDragActive`)

## Consequences

**Better:**
- Browser panes survive splits, moves, and sibling closes without reloading
- Consistent with how VS Code and other editors handle webviews
- No changes to the pane tree data model or store actions

**Harder:**
- Webview positioning relies on DOM measurements, which adds a `ResizeObserver` per browser slot
- Z-index coordination between the webview host layer and the pane tree (context menus, drop zones, find bar) needs care
- The `LeafPane` ↔ `BrowserPane` ref communication now crosses a portal boundary

**Risks:**
- Rect measurement could lag behind layout changes, causing brief visual misalignment (mitigated by `ResizeObserver` which fires synchronously with layout)
- Multiple webviews stacking in the host could affect performance if many browser panes are open (same as current behavior, just rendered differently)

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
