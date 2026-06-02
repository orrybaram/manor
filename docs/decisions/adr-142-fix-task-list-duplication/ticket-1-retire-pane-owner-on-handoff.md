---
title: Retire previous pane owner on CreateTask handoff
status: done
priority: critical
assignee: sonnet
blocked_by: []
---

# Retire previous pane owner on CreateTask handoff

When a new agent session reuses a pane that already had a task (the `/clear`,
resume, and compaction flows), the `CreateTask` effect must retire the old task's
**status**, not just its `paneId`. Today it only nulls `paneId`, leaving the old
record `status:"active"`, which is what makes it linger as a duplicate in the
sidebar.

## Implementation

In `electron/hook-relay-effects.ts`, inside the `case "CreateTask":` block,
replace the current prev-pane cleanup:

```ts
const prevPaneTask = deps.taskManager.getTaskByPaneId(effect.paneId);
if (prevPaneTask) {
  deps.taskManager.updateTask(prevPaneTask.id, { paneId: null });
}
```

with a version that also marks the prior task completed, clears its unseen
flags, and broadcasts the retirement so the renderer drops the stale row live:

```ts
const prevPaneTask = deps.taskManager.getTaskByPaneId(effect.paneId);
if (prevPaneTask) {
  const retired = deps.taskManager.updateTask(prevPaneTask.id, {
    paneId: null,
    status: "completed",
    completedAt: new Date().toISOString(),
  });
  deps.unseenRespondedTasks.delete(prevPaneTask.id);
  deps.unseenInputTasks.delete(prevPaneTask.id);
  if (retired) deps.broadcastTask(retired);
}
```

Notes:
- Use the existing `updateTask` on `ITaskManager` — do NOT add a new method to
  the interface. `updateTask` accepts a `Partial<TaskInfo>` so `status` and
  `completedAt` work.
- Keep the rest of the `CreateTask` block unchanged (the `createTask` call,
  `activatedAt` update, `requires_input` unseen handling, and final
  `broadcastTask(task)` for the new task). The new broadcast for the retired task
  must come BEFORE the new task is created/broadcast to preserve a sensible event
  order.

## Regression test

Add a test to `electron/__tests__/relay-subagent-tracking.test.ts` (it already
builds a real `relay()` over a fake `ITaskManager` via `buildRelay()` /
`makeFakeTaskManager`). Assert the core invariant:

- Drive an active event for `sessionId=A` on `paneId=P` → one active task.
- Simulate the session handoff: a `SessionStart` for `sessionId=B` on the same
  `paneId=P` (replacing the root), then an active event for `sessionId=B`.
- Assert: after the handoff there is exactly ONE task with `status==="active"`
  whose `paneId===P`, and the original task (session A) is now
  `status==="completed"` with `paneId===null`.

Look at existing tests in that file for the exact event-shape helpers and how
`SessionStart` / active events are dispatched through `relay()`. Mirror their
style. Confirm `broadcastTask` was called for the retired task.

## Files to touch
- `electron/hook-relay-effects.ts` — retire prev pane task status + broadcast in the `CreateTask` effect.
- `electron/__tests__/relay-subagent-tracking.test.ts` — add the handoff regression test.
