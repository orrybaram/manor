---
title: Pane closure hook — abandon task when pane is explicitly closed
status: done
priority: high
assignee: sonnet
blocked_by: [1]
---

# Pane Closure Hook — Abandon Task When Pane Is Explicitly Closed

When the user closes a pane via the UI, immediately mark any active task linked to that pane as `"abandoned"`. This is the real-time counterpart to the startup reconciliation in ticket 1.

## Background

`closePaneById()` in `src/store/app-store.ts:1503` removes a pane from the layout and clears all pane-related store state. But it never calls `taskManager.unlinkPane()` or marks the associated task as abandoned.

`electron/task-persistence.ts` already has `unlinkPane(paneId)` which clears the `paneId` field on tasks — but we want to go further and mark the task `"abandoned"`, not just unlink it, because the agent is truly gone.

## Implementation

### 1. Add `abandonTaskForPane` IPC handler (main process)

In the same IPC file used for ticket 1 (likely `electron/ipc/tasks.ts` or similar), add:

```typescript
ipcMain.handle("abandonTaskForPane", async (_event, paneId: string) => {
  const task = taskManager.getTaskByPaneId(paneId);
  if (task && task.status === "active") {
    const updated = taskManager.updateTask(task.id, {
      status: "abandoned",
      completedAt: new Date().toISOString(),
    });
    if (updated) broadcastTask(updated);
  }
});
```

Verify that `taskManager.getTaskByPaneId(paneId)` exists in `electron/task-persistence.ts` (it should — seen at line ~195). If it doesn't exist, add it or use `taskManager.getTasks().find(t => t.paneId === paneId)`.

### 2. Expose in preload (if typed)

If `electron/preload.ts` has typed API declarations (look for `contextBridge.exposeInMainWorld`), add `abandonTaskForPane` alongside other task-related methods. If there's no typed preload, the `window.electron.invoke()` call works without changes.

### 3. Call from `closePaneById()` in renderer

In `src/store/app-store.ts`, find `closePaneById` (~line 1503). Before the pane removal logic, fire the IPC:

```typescript
closePaneById: (paneId: string) => {
  // Abandon any active task linked to this pane
  window.electron.invoke("abandonTaskForPane", paneId).catch(console.error);

  // ... existing pane removal logic unchanged ...
},
```

Fire-and-forget pattern — the IPC call does not block the pane removal. If it fails, the task will self-correct on next startup via the reconciliation (ticket 1).

### Notes

- Only call on the main `closePaneById` — not on tab close or workspace changes (those have different semantics)
- The `window.electron.invoke` call should match the pattern already used elsewhere in `app-store.ts` — grep for existing `invoke` calls to find the right API shape
- After this change, the `TasksList.tsx` visibility logic will naturally hide the task once the pane is gone AND the status is `abandoned` — no UI changes needed

## Files to Touch

- `electron/ipc/tasks.ts` (or equivalent) — add `abandonTaskForPane` handler
- `electron/preload.ts` — expose if typed
- `src/store/app-store.ts` — call `abandonTaskForPane` at top of `closePaneById`

## REQUIRED: Commit your work

When your implementation is complete, you MUST create a git commit. This is not optional.

Run:
  git add -A
  git commit -m "feat(adr-116): pane closure hook — abandon task when pane is explicitly closed"

Do not push.
