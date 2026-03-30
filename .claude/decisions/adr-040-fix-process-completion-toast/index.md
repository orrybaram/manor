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

# ADR-040: Fix missing in-app toast for process completion

## Context

In-app toast notifications no longer appear when a task's agent finishes (transitions to `responded` or `complete`). The `receiveTaskUpdate` handler in `src/store/task-store.ts` only shows a toast for `requires_input` (line 137-154). There is no equivalent toast for `responded` or `complete` when the task pane is not currently visible.

Desktop notifications (`maybeSendNotification` in `electron/main.ts`) correctly handle `responded`, but only fire when the window is unfocused. There is no in-app toast to inform the user when a background task finishes while the app is focused but the task pane isn't visible.

## Decision

Add toast notifications in `receiveTaskUpdate` (in `src/store/task-store.ts`) for:

1. **`responded`** status — "Task responded" toast with a "Go to task" action, auto-dismissing after 3 seconds. Only shown when the task pane is not already visible.
2. **`complete`** status — "Task completed" toast with a "Go to task" action, auto-dismissing after 3 seconds. Only shown when the task pane is not already visible.

This mirrors the existing pattern used for `requires_input` but uses non-persistent, auto-dismissing toasts (since these are informational, not blocking).

## Consequences

- Users will see in-app toasts when background tasks finish, restoring the expected notification behavior.
- Toast IDs are keyed by task ID to prevent duplicates (`task-responded-{id}`, `task-complete-{id}`).
- No changes needed in the Electron main process — this is purely a renderer-side fix.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
