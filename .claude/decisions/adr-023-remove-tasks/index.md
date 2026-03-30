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

# ADR-023: Add Ability to Remove Tasks from Task View

## Context

The TasksView modal displays all tasks (active, completed, errored, abandoned) but provides no way to remove tasks from the list. Over time this list grows indefinitely since tasks are persisted to `tasks.json`. Users need a way to clean up old or unwanted tasks.

Currently the only operations on tasks are create, update, and status transitions. There is no delete method in `TaskManager`, no IPC handler for deletion, and no UI affordance for removal.

## Decision

Add a delete task capability across the full stack:

1. **TaskManager** (`electron/task-persistence.ts`): Add a `deleteTask(id)` method that removes a task from the internal map and persists the change.

2. **IPC handler** (`electron/main.ts`): Add a `tasks:delete` handler that calls `taskManager.deleteTask()`.

3. **Preload** (`electron/preload.ts`): Expose `tasks.delete(taskId)` via the context bridge.

4. **Type definitions** (`src/electron.d.ts`): Add `delete` to the `tasks` interface.

5. **Task store** (`src/store/task-store.ts`): Add a `removeTask(taskId)` action that calls the API and removes the task from local state.

6. **TasksView UI** (`src/components/TasksView.tsx` + CSS): Add a remove button (X icon) on each task row that appears on hover. Clicking it calls `removeTask`. Only non-active tasks can be removed (active tasks must be stopped first).

## Consequences

- Users can clean up their task history
- Deletion is permanent — no undo. This is acceptable since tasks are ephemeral session records, not critical data.
- Active tasks are protected from accidental removal

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
