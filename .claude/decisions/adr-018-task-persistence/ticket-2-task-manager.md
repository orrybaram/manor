---
title: Create TaskManager persistence class
status: done
priority: critical
assignee: sonnet
blocked_by: []
---

# Create TaskManager persistence class

New `TaskManager` class following the `ProjectManager` pattern in `electron/persistence.ts`.

## Files to touch

- `electron/task-persistence.ts` (NEW) — The full TaskManager class:

```typescript
interface TaskInfo {
  id: string;
  claudeSessionId: string;
  name: string | null;
  status: "active" | "completed" | "error" | "abandoned";
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  projectId: string | null;
  projectName: string | null;
  workspacePath: string | null;
  cwd: string;
  agentKind: "claude" | "opencode" | "codex";
  paneId: string | null;
  lastAgentStatus: string | null;
}
```

## Implementation notes

- Storage path: `manorDataDir() + "/tasks.json"` (reuse `manorDataDir()` from persistence.ts or extract to shared util)
- Constructor loads from disk, builds an internal `Map<string, TaskInfo>` indexed by `claudeSessionId` for O(1) lookups
- `saveState()` should be debounced (500ms) since hook events arrive rapidly
- Public methods:
  - `createTask(data: Omit<TaskInfo, 'id' | 'createdAt' | 'updatedAt'>): TaskInfo`
  - `updateTask(id: string, updates: Partial<TaskInfo>): TaskInfo | null`
  - `getTaskBySessionId(claudeSessionId: string): TaskInfo | null`
  - `getAllTasks(opts?: { projectId?: string; status?: string; limit?: number; offset?: number }): TaskInfo[]`
  - `setTaskStatus(id: string, status: TaskInfo['status']): void` — auto-sets `completedAt` for completed/error
  - `linkPane(claudeSessionId: string, paneId: string): void`
  - `unlinkPane(paneId: string): void`
- Sort tasks by `createdAt` descending in `getAllTasks`
- Follow the `loadState()`/`saveState()` pattern from `ProjectManager`
