---
title: Add orphan-task sweep for tasks without session state
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Add orphan-task sweep for tasks without session state

Any code path that drops `sessionStateMap[sessionId]` while the linked task's `lastAgentStatus` is still active leaves the task unrecoverable — `sweepStaleSessions()` iterates `sessionStateMap` and can't see orphans. Sources include `SessionStart` replacement (also fixed in ticket 2), early `SessionEnd` races, and main-process restarts that rehydrate tasks without their session state.

Add a second pass inside `sweepStaleSessions()` that scans active tasks and forces `applyStopForSession` for any whose `agentSessionId` has no entry in `sessionStateMap`.

See ADR-132 §"Fix 3" for full reasoning.

## What to change

### 1. Extend `ITaskManager` and `TaskManager`

Add a `getActiveTasks()` method.

In `electron/hook-relay.ts`, on the `ITaskManager` interface:

```ts
export interface ITaskManager {
  createTask(data: Omit<TaskInfo, "id" | "createdAt" | "updatedAt" | "activatedAt">): TaskInfo;
  updateTask(id: string, updates: Partial<TaskInfo>): TaskInfo | null;
  getTaskBySessionId(sessionId: string): TaskInfo | null;
  getTaskByPaneId(paneId: string): TaskInfo | null;
  getActiveTasks(): TaskInfo[];   // ← NEW
}
```

In `electron/task-persistence.ts`, implement on `TaskManager`. Read the file first to find existing query patterns — mimic them (likely a `WHERE status = 'active'` SQLite query, or an in-memory filter, whichever the class already uses). Order doesn't matter. Return every task currently in `status: "active"`.

### 2. Add orphan pass inside `sweepStaleSessions`

In `electron/hook-relay.ts`, `sweepStaleSessions()`, after the existing `for (const [sessionId, state] of sessionStateMap)` loop, add:

```ts
// Branch 3 (ADR-132): task is active but its session state is gone.
// Catches orphans from SessionStart replacement, SessionEnd races, and
// main-process restarts that rehydrate tasks without their sessionState.
const ORPHAN_TASK_MS = STALE_ACTIVE_MS; // share the 60s threshold
const nowMs = Date.now();
for (const task of taskManager.getActiveTasks()) {
  if (!task.agentSessionId) continue;
  if (sessionStateMap.has(task.agentSessionId)) continue;
  if (
    task.lastAgentStatus !== "thinking" &&
    task.lastAgentStatus !== "working"
  ) continue;

  const activatedMs = task.activatedAt ? Date.parse(task.activatedAt) : 0;
  if (!activatedMs || nowMs - activatedMs < ORPHAN_TASK_MS) continue;

  console.debug(
    `[task-lifecycle] orphan-task sweep: forcing responded on ${task.agentSessionId} ` +
      `(task.id=${task.id}, lastAgentStatus=${task.lastAgentStatus}, age=${nowMs - activatedMs}ms)`,
  );
  applyStopForSession(task.agentSessionId);
}
```

Note: `applyStopForSession` is idempotent (sets `lastAgentStatus: "responded"`) and re-reads the task via `getTaskBySessionId`, so calling it here is safe.

### 3. Update the fake task manager in tests

Tests will be added in ticket 4, but the fake `makeFakeTaskManager` in `electron/__tests__/relay-subagent-tracking.test.ts` does not yet implement `getActiveTasks`. Because the new method is on `ITaskManager`, TypeScript will fail to compile the existing tests until the fake is extended. Add a minimal implementation to keep the test file compiling:

```ts
function getActiveTasks(): TaskInfo[] {
  return Array.from(tasks.values()).filter((t) => t.status === "active");
}
```

Include it in the returned object. Do not add new test cases here — those come in ticket 4.

## Files to touch

- `electron/hook-relay.ts` — add `getActiveTasks` to `ITaskManager`; add orphan-task pass inside `sweepStaleSessions`.
- `electron/task-persistence.ts` — implement `getActiveTasks()` on `TaskManager` in the style of the existing class.
- `electron/__tests__/relay-subagent-tracking.test.ts` — extend the fake `makeFakeTaskManager` with `getActiveTasks` so the test file still compiles. No new test cases.
