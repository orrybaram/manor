---
title: Add task IPC handlers, preload API, and types
status: done
priority: critical
assignee: sonnet
blocked_by: [1, 2]
---

# Add task IPC handlers, preload API, and types

Wire the TaskManager into the Electron main process with IPC handlers, expose via preload, and add TypeScript types.

## Files to touch

- `src/electron.d.ts` — Add `TaskInfo` type (export interface), `TaskStatus` type alias, and extend `ElectronAPI` with:
  ```typescript
  tasks: {
    getAll: (opts?: { projectId?: string; status?: string; limit?: number; offset?: number }) => Promise<TaskInfo[]>;
    get: (taskId: string) => Promise<TaskInfo | null>;
    update: (taskId: string, updates: Partial<TaskInfo>) => Promise<TaskInfo | null>;
    setPaneContext: (paneId: string, context: { projectId: string; projectName: string; workspacePath: string }) => Promise<void>;
    onUpdate: (callback: (task: TaskInfo) => void) => () => void;
  };
  ```

- `electron/preload.ts` — Add `tasks` namespace to `contextBridge.exposeInMainWorld` matching the API above. Use the existing `onChannel` helper for `onUpdate`.

- `electron/main.ts` — Multiple changes:
  1. Import and instantiate `TaskManager`
  2. Add a `paneContextMap: Map<string, { projectId: string; projectName: string; workspacePath: string }>` at module level
  3. Register IPC handlers: `tasks:getAll`, `tasks:get`, `tasks:update`, `tasks:setPaneContext`
  4. `tasks:setPaneContext` stores into the paneContextMap
  5. Enhance the `agentHookServer.setRelay()` callback (line ~680) to:
     - Accept the `sessionId` param from ticket 1
     - If sessionId is present and no task exists for it: create task using `paneContextMap.get(paneId)` for project context
     - On every hook: update task's `lastAgentStatus` and `updatedAt`
     - On `Stop` -> set status "completed"; `StopFailure` -> "error"; `SessionEnd` -> "completed"
     - After each update: `mainWindow.webContents.send("task-updated", task)`
  6. Relay the sessionId through to `client.relayAgentHook()` (add param if needed, or just handle task creation before relaying)

## Implementation notes

- The paneContextMap solves the "which project owns this pane" problem without querying the renderer
- If a hook event arrives before `setPaneContext`, create the task with null project info. A later `setPaneContext` call can backfill it.
- Follow the existing IPC handler patterns in main.ts (use `assertString` for validation)
