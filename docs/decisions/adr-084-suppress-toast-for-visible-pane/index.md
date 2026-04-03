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

# ADR-084: Suppress toast notifications when user is viewing the pane

## Context

Toast notifications for session events (task responded, requires input, completed) fire even when the user is actively viewing the pane that triggered the notification. The visibility check in `receiveTaskUpdate` (`src/store/task-store.ts:122-138`) iterates **all** workspace sessions instead of only the active workspace, which means:

1. If the pane is in a non-active workspace's selected session, it's incorrectly marked as "visible" and the toast is suppressed — even though the user can't see it.
2. Conversely, the check doesn't use `activeWorkspacePath` to scope to the workspace the user is actually viewing.

The `getActiveWorkspace` helper already exists at `src/store/app-store.ts:172-176` and returns the session state for the current workspace.

## Decision

Replace the all-workspaces iteration in `receiveTaskUpdate` with a scoped check that:

1. Uses `appState.activeWorkspacePath` to identify the workspace the user is currently viewing.
2. Gets the selected session for that workspace only.
3. Checks if `task.paneId` is in that session's pane tree via `allPaneIds`.

This is a single-function change in `src/store/task-store.ts`. The same `allPaneIds` approach is correct for split views (all visible panes should suppress toasts), but scoping to the active workspace is the fix.

## Consequences

- **Fixes**: Toasts will correctly suppress when the user is viewing the pane in the active workspace.
- **Fixes**: Toasts will correctly show when the pane is in a non-active workspace (even if it's in that workspace's selected session).
- **No impact** on desktop notifications (`maybeSendNotification` in `electron/main.ts`) which already gate on `mainWindow.isFocused()`.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
