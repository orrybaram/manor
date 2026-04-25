---
title: Refresh task.cwd from OSC 7 stream events
status: todo
priority: medium
assignee: haiku
blocked_by: []
---

# Refresh task.cwd from OSC 7 stream events

`task.cwd` is set once at task creation from `paneContext.workspacePath` (`electron/hook-relay.ts:221`). Live cwd is tracked separately on the daemon session via OSC 7 and forwarded as a `cwd` stream event (`app-lifecycle.ts:126-128`), but never propagated to the persisted task. A user `cd`-ing into a subdirectory mid-session sees no update in tasks.json or the history modal.

See ADR-135 §"Change 9" for context.

## What to change

In `electron/app-lifecycle.ts:126-128`, the `case "cwd":` arm currently only forwards to the renderer. Extend it to also update the task:

```ts
case "cwd":
  mainWindow.webContents.send(`pty-cwd-${event.sessionId}`, event.cwd);
  {
    const task = taskManager.getTaskByPaneId(event.sessionId);
    if (task && task.status === "active" && task.cwd !== event.cwd) {
      const updated = taskManager.updateTask(task.id, { cwd: event.cwd });
      if (updated) {
        try {
          mainWindow.webContents.send("task-updated", updated);
        } catch {
          // Render frame disposed — safe to ignore
        }
      }
    }
  }
  break;
```

Only update active tasks (no point churning history). The 500 ms `saveState` debounce already coalesces rapid `cd`s.

## Files to touch

- `electron/app-lifecycle.ts` — extend the `case "cwd":` arm in the stream event handler.

## Tests

Unit-testing this is awkward because it lives inside `initApp` directly. Either:
1. Extract the stream event handler into a small named function (`handleStreamEvent(deps, event, mainWindow)`) and test it in isolation.
2. Add an integration-flavor test that spawns a fake stream-event source through `backend.pty.onEvent` and asserts the task is updated.

Option 1 is preferred — small refactor, big testability gain.

Test cases:
- Active task, cwd event differs → task updated, broadcast fires.
- Active task, cwd event matches existing → no update, no broadcast.
- Completed task → no update.
- No task for the paneId → no-op.
