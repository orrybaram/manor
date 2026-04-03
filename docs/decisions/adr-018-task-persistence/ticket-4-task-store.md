---
title: Create Zustand task store
status: done
priority: high
assignee: sonnet
blocked_by: [3]
---

# Create Zustand task store

New Zustand store for task state on the renderer side.

## Files to touch

- `src/store/task-store.ts` (NEW) — Zustand store following `project-store.ts` pattern:

```typescript
interface TaskState {
  tasks: TaskInfo[];
  loading: boolean;
  loaded: boolean;
  loadTasks: (opts?: { projectId?: string; status?: string; limit?: number; offset?: number }) => Promise<void>;
  loadMoreTasks: (offset: number) => Promise<void>;
  receiveTaskUpdate: (task: TaskInfo) => void;
}
```

## Implementation notes

- `loadTasks()` calls `window.electronAPI.tasks.getAll(opts)` and replaces `tasks`
- `loadMoreTasks(offset)` appends to existing tasks (for pagination)
- `receiveTaskUpdate(task)` — upserts: if task.id exists in array, replace it; otherwise prepend it
- On store creation, subscribe to `window.electronAPI.tasks.onUpdate()` to call `receiveTaskUpdate` automatically
- Export `useTaskStore` hook (standard Zustand pattern)
- Store tasks sorted by `createdAt` descending (most recent first)
