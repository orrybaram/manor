---
title: Create drag-overlay Zustand store
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Create drag-overlay Zustand store

Create a minimal Zustand store that tracks whether any drag operation is active.

## Implementation

Create `src/store/drag-overlay-store.ts`:
- State: `dragCount: number`
- Actions: `incrementDragCount()`, `decrementDragCount()`
- Derived selector: `selectIsDragActive(state)` → `state.dragCount > 0`

Use a counter rather than a boolean so overlapping drag start/end calls don't miscount.

## Files to touch
- `src/store/drag-overlay-store.ts` — new file
