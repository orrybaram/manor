---
title: Handle notification click navigation in renderer
status: done
priority: high
assignee: sonnet
blocked_by: [2]
---

# Handle notification click navigation in renderer

When a desktop notification is clicked, the main process sends `"notification:navigate-to-task"` with a taskId. The renderer needs to listen for this and navigate to the task.

## Implementation details

- In `task-store.ts`, subscribe to the new IPC channel on store creation (same pattern as `tasks.onUpdate`)
- On receiving a taskId, find the task in the store's task list and call `navigateToTask(task)`
- If the task isn't in the loaded list, call `window.electronAPI.tasks.get(taskId)` to fetch it first

## Files to touch

- `src/store/task-store.ts` — Add listener for `notification:navigate-to-task` channel, look up task and call `navigateToTask()`
