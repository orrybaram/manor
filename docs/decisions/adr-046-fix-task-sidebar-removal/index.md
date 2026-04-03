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

# ADR-046: Fix task not removed from sidebar when clicking X

## Context

When clicking the X button on a task in the sidebar (`TasksList.tsx`), tasks with an associated `paneId` are not removed from the sidebar. The click handler only calls `closePaneById()` which closes the terminal pane but never calls `removeTask()` to remove the task from the task store. Tasks without a `paneId` work correctly because they call `removeTask()` directly.

## Decision

Update the X button click handler in `TasksList.tsx` to always call `removeTask()` after closing the pane. When a task has a `paneId`, both operations should happen: close the pane AND remove the task from the store.

**File:** `src/components/TasksList.tsx` lines 186-193

Change from:
```tsx
if (task.paneId) {
  useAppStore.getState().closePaneById(task.paneId);
} else {
  useTaskStore.getState().removeTask(task.id);
}
```

To:
```tsx
if (task.paneId) {
  useAppStore.getState().closePaneById(task.paneId);
}
useTaskStore.getState().removeTask(task.id);
```

## Consequences

- Tasks will be properly removed from the sidebar when clicking X
- The pane will still be closed if one exists
- The task will be deleted from persistence (tasks.json) via the existing `removeTask` flow

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
