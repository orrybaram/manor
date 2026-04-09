---
title: Create WebviewSlot component
status: todo
priority: critical
assignee: sonnet
blocked_by: [1]
---

# Create WebviewSlot component

Create a lightweight placeholder component that `LeafPane` renders in place of `BrowserPane`. It measures its own bounding rect and reports it to the webview host store.

## Implementation

Create `src/components/workspace-panes/WebviewSlot.tsx`:

- Render a `<div>` with `width: 100%; height: 100%; position: relative;`
- On mount, create a `ResizeObserver` on the div
- On every resize callback, read `getBoundingClientRect()` and call `setSlotRect(paneId, rect)` on the webview host store
- On unmount, call `removeSlot(paneId)` and disconnect the observer
- The div should have a `data-webview-slot={paneId}` attribute for debugging

The component receives `paneId` as a prop. It renders no visible content — the webview will be positioned on top of it by `WebviewHost`.

Also needs to handle visibility: accept a `visible` prop (true when the tab is selected and pane is not being dragged). Call `setSlotVisible(paneId, visible)` when it changes.

## Files to touch
- `src/components/workspace-panes/WebviewSlot.tsx` — new file
