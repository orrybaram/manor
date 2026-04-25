---
title: Add id-index for O(1) task lookups
status: todo
priority: medium
assignee: sonnet
blocked_by: []
---

# Add id-index for O(1) task lookups

`tasks:get` (`electron/ipc/tasks.ts:32-36`) walks all tasks via `getAllTasks()` (which sorts) on every lookup. `TaskManager.updateTask`, `setTaskStatus`, and `deleteTask` similarly scan via `Array.from(this.tasks.values()).find(...)`. Tasks are indexed only by `agentSessionId`.

See ADR-138 §"Change 1" for full reasoning.

## What to change

In `electron/task-persistence.ts`:

```ts
private idIndex: Map<string, string> = new Map();   // taskId → agentSessionId
```

### Initialize in loadState (after the migration block)

```ts
const map = new Map<string, TaskInfo>();
const idIndex = new Map<string, string>();
for (const task of state.tasks ?? []) {
  // ... existing migration logic ...
  map.set(migrated.agentSessionId, migrated);
  idIndex.set(migrated.id, migrated.agentSessionId);
}
this.idIndex = idIndex;
return map;
```

### Maintain on mutations

- `createTask`: after `this.tasks.set(...)`, do `this.idIndex.set(task.id, task.agentSessionId)`.
- `updateTask`: assert `updates.agentSessionId === undefined` (id is stable; if needed, throw a defensive error). Otherwise no idIndex change.
- `deleteTask`: after `this.tasks.delete(sessionId)`, do `this.idIndex.delete(task.id)`.
- `setTaskStatus`, `linkPane`, `unlinkPane`: don't change agentSessionId or id, no idIndex change.

### Add `getTaskById`

```ts
getTaskById(id: string): TaskInfo | null {
  const sessionId = this.idIndex.get(id);
  if (!sessionId) return null;
  return this.tasks.get(sessionId) ?? null;
}
```

### Use it everywhere id is the lookup key

- `tasks:get` IPC handler.
- `updateTask` body — replace `Array.from(this.tasks.values()).find((t) => t.id === id)` with `getTaskById(id)`.
- `setTaskStatus` body — same.
- `deleteTask` body — same. Iterate the idIndex instead of `for (const [sessionId, task] of this.tasks)`.

## Files to touch

- `electron/task-persistence.ts` — add idIndex, maintain in mutations, add `getTaskById`, use it internally.
- `electron/ipc/tasks.ts` — `tasks:get` calls `taskManager.getTaskById`.

## Tests

Add to `electron/task-persistence.test.ts`:

1. After `createTask`, `getTaskById(task.id)` returns the task; `getAllTasks().length === 1`.
2. After `updateTask`, lookup still works.
3. After `deleteTask`, `getTaskById` returns null and `tasks.size === idIndex.size`.
4. After `loadState` from disk, idIndex matches tasks Map.
5. Defensive: `updateTask` rejects an `agentSessionId` field in the update partial.
