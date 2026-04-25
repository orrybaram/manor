---
title: Allowlist tasks:update IPC fields
status: todo
priority: high
assignee: sonnet
blocked_by: []
---

# Allowlist tasks:update IPC fields

`tasks:update` (`electron/ipc/tasks.ts:38-44`) accepts any `Partial<TaskInfo>` from the renderer. Internal lifecycle fields (`status`, `agentSessionId`, `lastAgentStatus`, `activatedAt`, `completedAt`, `resumedAt`, `paneId`) should be owned exclusively by main.

See ADR-136 §"Change 1" for full reasoning.

## What to change

In `electron/ipc/tasks.ts`:

```ts
const ALLOWED_RENDERER_TASK_FIELDS: ReadonlySet<string> = new Set([
  "name",
]);

function assertRendererTaskUpdate(updates: unknown): asserts updates is Record<string, unknown> {
  if (!updates || typeof updates !== "object") {
    throw new Error("tasks:update: updates must be an object");
  }
  for (const key of Object.keys(updates as object)) {
    if (!ALLOWED_RENDERER_TASK_FIELDS.has(key)) {
      throw new Error(`tasks:update: field "${key}" is not writable from renderer`);
    }
  }
}

ipcMain.handle("tasks:update", (_event, taskId: string, updates: unknown) => {
  assertString(taskId, "taskId");
  assertRendererTaskUpdate(updates);
  return taskManager.updateTask(taskId, updates);
});
```

Then in `src/electron.d.ts` and `electron/preload.ts`, narrow the type of `electronAPI.tasks.update`:

```ts
update: (taskId: string, updates: { name?: string | null }) => Promise<TaskInfo | null>;
```

## Files to touch

- `electron/ipc/tasks.ts` — add allowlist + assert.
- `electron/preload.ts` — narrow type.
- `src/electron.d.ts` — narrow type.

## Audit

Search the renderer for `electronAPI.tasks.update` callers. Today the field set should be small (likely just `name`). If any caller writes a non-allowed field, surface as a follow-up — do NOT widen the allowlist to accommodate; the call site is a bug.

## Tests

Add to `electron/__tests__/`:

1. Calling `tasks:update` with `{ name: "x" }` succeeds and forwards to `taskManager.updateTask`.
2. Calling with `{ status: "abandoned" }` throws/rejects.
3. Calling with `{ name: "x", status: "active" }` throws/rejects (mixed-case).
4. Calling with non-object updates throws/rejects.
