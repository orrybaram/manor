---
title: Tests for stale task reconciliation and pane closure abandonment
status: todo
priority: high
assignee: sonnet
blocked_by: [1, 2]
---

# Tests for Stale Task Reconciliation and Pane Closure Abandonment

Write tests covering the two fixes introduced in tickets 1 and 2.

## Background

Before writing tests, read the existing test setup to understand the testing patterns used in this codebase:
- Look for `*.test.ts`, `*.spec.ts` files in `electron/` and `src/`
- Check for a `vitest.config.ts` or `jest.config.ts` to understand the test runner
- Check if there are existing mocks for `taskManager` or `ptyClient`

## Tests to Write

### Test Suite A: `reconcileStaleTasks`

File: `electron/__tests__/reconcile-stale-tasks.test.ts` (or follow existing file structure)

```
describe("reconcileStaleTasks")

  it("marks active tasks with dead sessions as abandoned")
    - Mock taskManager.getTasks() → [task1 (active, sessionId: "s1"), task2 (active, sessionId: "s2")]
    - Mock ptyClient.listSessions() → [{ id: "s2" }]  // only s2 is alive
    - Call reconcileStaleTasks()
    - Assert taskManager.updateTask called with task1.id, { status: "abandoned", completedAt: <any string> }
    - Assert taskManager.updateTask NOT called for task2 (it's still alive)
    - Assert broadcastTask called with the updated task1

  it("does not mark tasks as abandoned when daemon is not connected")
    - Mock ptyClient.isConnected() → false (or make listSessions throw)
    - Call reconcileStaleTasks()
    - Assert taskManager.updateTask never called

  it("does not mark tasks with null agentSessionId as abandoned")
    - Mock taskManager.getTasks() → [task with agentSessionId: null, status: "active"]
    - Mock ptyClient.listSessions() → []
    - Assert taskManager.updateTask never called

  it("ignores already-completed tasks")
    - Mock getTasks() → [task with status: "completed", agentSessionId: "s1"]
    - Mock listSessions() → []  // s1 is dead, but task is already completed
    - Assert updateTask never called
```

### Test Suite B: `abandonTaskForPane` IPC handler

File: `electron/__tests__/abandon-task-for-pane.test.ts` (or follow existing pattern)

```
describe("abandonTaskForPane IPC handler")

  it("marks the active task for a pane as abandoned")
    - Mock taskManager.getTaskByPaneId("pane-1") → task (status: "active")
    - Invoke the handler with paneId: "pane-1"
    - Assert taskManager.updateTask called with task.id, { status: "abandoned", completedAt: <any> }
    - Assert broadcastTask called

  it("does nothing if no task is linked to the pane")
    - Mock taskManager.getTaskByPaneId("pane-99") → undefined
    - Invoke the handler with paneId: "pane-99"
    - Assert taskManager.updateTask never called

  it("does nothing if the task is not active")
    - Mock taskManager.getTaskByPaneId("pane-1") → task (status: "completed")
    - Assert taskManager.updateTask never called
```

### Test Suite C: `closePaneById` integration (renderer)

File: `src/store/__tests__/app-store-close-pane.test.ts` (or alongside existing store tests)

```
describe("closePaneById task abandonment")

  it("calls abandonTaskForPane IPC with the correct paneId")
    - Spy on window.electron.invoke
    - Set up store with a pane "pane-1" in the layout
    - Call closePaneById("pane-1")
    - Assert window.electron.invoke called with "abandonTaskForPane", "pane-1"
```

## Notes

- Follow whatever mock/test patterns are already established in the codebase
- If the project uses `vitest`, use `vi.fn()` and `vi.mock()`; if `jest`, use `jest.fn()`
- For renderer tests, you may need to mock `window.electron` — check how other store tests handle this
- Don't over-test: focus on the paths that matter for this bug (the three suites above)
- All tests should pass before committing

## Files to Touch

- `electron/__tests__/reconcile-stale-tasks.test.ts` — new file (or adjust path to match existing pattern)
- `electron/__tests__/abandon-task-for-pane.test.ts` — new file
- `src/store/__tests__/app-store-close-pane.test.ts` — new file (or adjust to match existing pattern)

## REQUIRED: Commit your work

When your implementation is complete, you MUST create a git commit. This is not optional.

Run:
  git add -A
  git commit -m "test(adr-116): tests for stale task reconciliation and pane closure abandonment"

Do not push.
