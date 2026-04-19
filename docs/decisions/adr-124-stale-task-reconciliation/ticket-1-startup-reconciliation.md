---
title: Startup reconciliation — abandon tasks with dead sessions
status: done
priority: critical
assignee: sonnet
blocked_by: []
---

# Startup Reconciliation — Abandon Tasks With Dead Sessions

After the app restores its layout from disk, cross-check every active task's `agentSessionId` against the daemon's live session list. Any task whose session is no longer alive gets marked `"abandoned"`.

## Background

Tasks are persisted to disk with `agentSessionId` and `paneId`. When the PTY daemon restarts (crash, `pnpm dev` restart, branch change), old session IDs become invalid. The `SessionEnd` hook never fires for killed sessions, so tasks stay `"active"` in the sidebar forever.

`listSessions()` in `electron/terminal-host/client.ts:303` returns all currently-alive daemon sessions. This is the source of truth.

## Implementation

### 1. Add `reconcileStaleTasks()` in `app-lifecycle.ts`

In `electron/app-lifecycle.ts`, add a new exported function (or internal helper exposed via IPC):

```typescript
async function reconcileStaleTasks() {
  // Guard: only run if daemon is connected
  if (!ptyClient.isConnected()) return;

  const liveSessions = await ptyClient.listSessions();
  const liveIds = new Set(liveSessions.map((s) => s.id));

  const allTasks = taskManager.getTasks();
  for (const task of allTasks) {
    if (task.status === "active" && task.agentSessionId && !liveIds.has(task.agentSessionId)) {
      const updated = taskManager.updateTask(task.id, {
        status: "abandoned",
        completedAt: new Date().toISOString(),
      });
      if (updated) broadcastTask(updated);
    }
  }
}
```

Check whether `ptyClient` has an `isConnected()` method or equivalent — look in `electron/terminal-host/client.ts`. If not, check connection state via `listSessions()` catching errors (return early if it throws).

### 2. Expose via IPC

In the relevant IPC registration file (look for where other task-related IPC handlers are registered — likely `electron/ipc/tasks.ts` or similar), add:

```typescript
ipcMain.handle("reconcileStaleTasks", async () => {
  await reconcileStaleTasks();
});
```

### 3. Call from renderer after layout load

In `src/App.tsx`, in the `useMountEffect` block, after the `Promise.all([loadProjects(), loadPersistedLayout()])` resolves, invoke the IPC:

```typescript
Promise.all([loadProjects(), loadPersistedLayout()]).then(async () => {
  // ... existing workspace setup ...
  setAppReady(true);
  // Reconcile stale tasks after layout is known
  await window.electron.invoke("reconcileStaleTasks").catch(console.error);
});
```

The call is fire-and-forget (`catch` logs errors); it does not block the app ready state.

### Notes

- `broadcastTask` already handles notifying all renderer windows — reuse it
- `taskManager.getTasks()` should return all tasks including active ones — verify this returns the full list (check `electron/task-persistence.ts`)
- Do NOT mark tasks as abandoned if `agentSessionId` is null/empty (those are tasks without a session yet)
- Check whether `SessionInfo.id` matches the `agentSessionId` field — confirm in `electron/terminal-host/client.ts` what the `id` field of `SessionInfo` is

## Files to Touch

- `electron/app-lifecycle.ts` — add `reconcileStaleTasks()` function
- `electron/ipc/tasks.ts` (or wherever task IPC is registered) — add `reconcileStaleTasks` handler
- `src/App.tsx` — call `reconcileStaleTasks` after layout loads
- `electron/preload.ts` (if typed) — expose `reconcileStaleTasks` in the electron API type if needed

## REQUIRED: Commit your work

When your implementation is complete, you MUST create a git commit. This is not optional.

Run:
  git add -A
  git commit -m "feat(adr-124): startup reconciliation — abandon tasks with dead sessions"

Do not push.
