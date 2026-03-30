---
title: Wire drag sources to overlay store
status: done
priority: high
assignee: sonnet
blocked_by: [1]
---

# Wire drag sources to overlay store

Import and call `incrementDragCount`/`decrementDragCount` from the drag-overlay store in each of the four drag sources.

## Implementation

### PaneDragContext (`src/components/workspace-panes/PaneDragContext.tsx`)
- In `startDrag`, call `incrementDragCount()`
- In `endDrag`, call `decrementDragCount()`

### SplitLayout (`src/components/workspace-panes/SplitLayout.tsx`)
- In `handleMouseDown`, call `incrementDragCount()` at drag start
- In `onMouseUp`, call `decrementDragCount()`

### useWorkspaceDrag (`src/hooks/useWorkspaceDrag.ts`)
- When `dragActive.current` first becomes `true`, call `incrementDragCount()`
- In `onUp` cleanup, call `decrementDragCount()` (only if drag was active)

## Files to touch
- `src/components/workspace-panes/PaneDragContext.tsx` — add increment/decrement calls
- `src/components/workspace-panes/SplitLayout.tsx` — add increment/decrement calls
- `src/hooks/useWorkspaceDrag.ts` — add increment/decrement calls
