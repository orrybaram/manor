---
title: Ensure wizard changes instantly reflect in sidebar
status: done
priority: high
assignee: sonnet
blocked_by: [1]
---

# Ensure wizard changes instantly reflect in sidebar

When the user changes the project name or color in the wizard, the sidebar should update immediately.

## Implementation

1. Check `updateProject` in `src/store/project-store.ts` — it calls IPC then refreshes. The refresh may be async and cause a delay.

2. **Optimistic update**: Instead of waiting for the IPC round-trip, update the local store state immediately, then fire the IPC call. This makes changes feel instant.

3. Check how the Sidebar subscribes to `useProjectStore` — it should re-render when `projects` array reference changes.

## Files to touch
- `src/store/project-store.ts` — make `updateProject` optimistically update local state before IPC
- `src/components/Sidebar.tsx` — verify it subscribes to the right store selectors
