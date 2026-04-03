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

# ADR-024: Toast Notifications for Task Status Changes

## Context

When a task finishes ("Done") or needs user attention ("Require Input"), there's no notification — the user has to notice the status change in the sidebar. This is easy to miss, especially with multiple tasks running or when focused on another terminal.

The app already has a toast system (`toast-store.ts`, `Toast.tsx`, `ToastItem.tsx`) and a task store that receives live updates via `receiveTaskUpdate`. We just need to connect them.

## Decision

Add toast notifications in the task store's `receiveTaskUpdate` method when `lastAgentStatus` transitions to `"complete"` or `"requires_input"`.

- **"complete"** → success toast: `"Task completed: {name}"`
- **"requires_input"** → toast with action button: `"Task needs input: {name}"` with a "Go to task" action that calls `navigateToTask`

Implementation is a single file change to `src/store/task-store.ts`:
1. Import `useToastStore` and the `navigateToTask` helper
2. In `receiveTaskUpdate`, compare old `lastAgentStatus` with new — if it changed to `complete` or `requires_input`, fire a toast
3. The `navigateToTask` function needs to be extracted from `TasksList.tsx` to a shared location (or duplicated minimally)

To keep changes small, we'll extract `navigateToTask` into a small utility and import it in both places.

## Consequences

- Users get immediate visual feedback when tasks complete or need input
- Toast auto-dismisses for "complete" (success toast, 3s)
- "Requires input" toast should be persistent so the user doesn't miss it, with a "Go to task" action button
- No new dependencies needed — uses existing toast infrastructure

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
