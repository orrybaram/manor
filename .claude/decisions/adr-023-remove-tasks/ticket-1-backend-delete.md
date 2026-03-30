---
title: Add deleteTask to TaskManager and IPC layer
status: todo
priority: high
assignee: sonnet
blocked_by: []
---

# Add deleteTask to TaskManager and IPC layer

Add the backend capability to delete tasks.

## Implementation

### 1. `electron/task-persistence.ts` — Add `deleteTask` method

```typescript
deleteTask(id: string): boolean {
  for (const [sessionId, task] of this.tasks) {
    if (task.id === id) {
      this.tasks.delete(sessionId);
      this.saveState();
      return true;
    }
  }
  return false;
}
```

### 2. `electron/main.ts` — Add IPC handler

After the existing `tasks:update` handler, add:

```typescript
ipcMain.handle("tasks:delete", (_event, taskId: string) => {
  assertString(taskId, "taskId");
  return taskManager.deleteTask(taskId);
});
```

### 3. `electron/preload.ts` — Expose in context bridge

In the `tasks` object, add:

```typescript
delete: (taskId: string) => ipcRenderer.invoke("tasks:delete", taskId),
```

### 4. `src/electron.d.ts` — Add type

In the `tasks` interface, add:

```typescript
delete: (taskId: string) => Promise<boolean>;
```

## Files to touch
- `electron/task-persistence.ts` — add `deleteTask` method
- `electron/main.ts` — add `tasks:delete` IPC handler
- `electron/preload.ts` — expose `delete` in tasks API
- `src/electron.d.ts` — add `delete` to tasks type interface
