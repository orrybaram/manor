---
title: Add tasks:buildResumeCommand IPC bridging connector resume to the renderer
status: done
priority: critical
assignee: sonnet
blocked_by: [1]
---

# Add `tasks:buildResumeCommand` IPC

Connectors live in the main process; the relaunch logic runs in the renderer. Add an
IPC that computes the resume command for a task. See ADR-144.

## Requirements

1. **Main handler** in `electron/ipc/tasks.ts`, modeled on the existing
   `tasks:markResumed` handler (around line 122):
   ```ts
   ipcMain.handle("tasks:buildResumeCommand", (_event, taskId: string) => {
     assertString(taskId, "taskId");
     const task = taskManager.getTaskById(taskId);
     if (!task || !task.agentCommand) return null;
     return getConnector(task.agentKind).getResumeCommand(
       task.agentCommand,
       task.agentSessionId,
     );
   });
   ```
   Import `getConnector` from `../agent-connectors` (add the import if absent).
   Returns `string | null`.

2. **Preload** in `electron/preload.ts`, next to `markResumed` (around line 364):
   ```ts
   buildResumeCommand: (taskId: string) =>
     ipcRenderer.invoke("tasks:buildResumeCommand", taskId),
   ```

3. **Type** in `src/electron.d.ts`, next to `markResumed` (around line 548):
   ```ts
   buildResumeCommand: (taskId: string) => Promise<string | null>;
   ```

Do not change any resume behavior here — this ticket only exposes the connector
result. Wiring happens in ticket 3.

## Files to touch
- `electron/ipc/tasks.ts` — add the `tasks:buildResumeCommand` handler + `getConnector` import.
- `electron/preload.ts` — add `buildResumeCommand` to the tasks API surface.
- `src/electron.d.ts` — add the `buildResumeCommand` signature to the tasks interface.
