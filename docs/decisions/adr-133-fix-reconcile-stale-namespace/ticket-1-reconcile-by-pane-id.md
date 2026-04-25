---
title: Reconcile stale tasks by paneId, not agentSessionId
status: done
priority: critical
assignee: sonnet
blocked_by: []
---

# Reconcile stale tasks by paneId, not agentSessionId

`tasks:reconcileStale` in `electron/ipc/tasks.ts:104-144` compares `task.agentSessionId` (agent CLI's UUID, e.g. Claude's `session_id`) against the daemon's pane-keyed `sessionId` set returned by `backend.pty.listSessions()`. These two namespaces never overlap; the handler unconditionally abandons every active task with `lastAgentStatus !== "responded"` on every boot.

See ADR-133 for full reasoning.

## What to change

Switch the comparison to `task.paneId`. Skip tasks whose `paneId` is null — already-orphaned tasks (paneId nulled by the relay at `hook-relay.ts:207-210`) are not this handler's responsibility.

Target shape:

```ts
ipcMain.handle("tasks:reconcileStale", async () => {
  let liveSessions: Array<{ sessionId: string }>;
  try {
    liveSessions = await backend.pty.listSessions();
  } catch {
    return;
  }

  const livePaneIds = new Set(liveSessions.map((s) => s.sessionId));
  const allTasks = taskManager.getAllTasks();

  for (const task of allTasks) {
    if (task.status !== "active") continue;
    if (!task.paneId) continue;
    if (livePaneIds.has(task.paneId)) continue;
    if (task.lastAgentStatus === "responded") continue;

    const updated = taskManager.updateTask(task.id, {
      status: "abandoned",
      completedAt: new Date().toISOString(),
    });
    if (updated) {
      const { mainWindow } = deps;
      if (
        mainWindow &&
        !mainWindow.isDestroyed() &&
        !mainWindow.webContents.isDestroyed()
      ) {
        try {
          mainWindow.webContents.send("task-updated", updated);
        } catch {
          // Render frame disposed — safe to ignore
        }
      }
      updateDockBadge(preferencesManager);
    }
  }
});
```

Keep the `try/catch` around `listSessions()` so daemon-unreachable boots remain a no-op (existing behaviour, preserved by an existing test).

## Files to touch

- `electron/ipc/tasks.ts` — replace the `agentSessionId` comparison with `paneId` per above; add the `task.paneId` null-skip.

Tests are updated in ticket 2.
