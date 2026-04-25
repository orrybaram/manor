---
title: Paginate task loads + add retention pruning
status: todo
priority: high
assignee: opus
blocked_by: []
---

# Paginate task loads + add retention pruning

Two related issues:
- `useTaskStore` initializer calls `getAll()` with no opts on boot (`src/store/task-store.ts:44-50`), loading every task into memory.
- `tasks.json` has no retention — completed/abandoned tasks accumulate forever.

See ADR-136 §"Change 2" for full reasoning.

## What to change

### A. New IPC: `tasks:getActive`

Add a fast path that returns *just* the active tasks (no sort, no slice, no limit):

```ts
// electron/ipc/tasks.ts
ipcMain.handle("tasks:getActive", () => {
  return taskManager.getActiveTasks();
});
```

`TaskManager.getActiveTasks()` already exists (lines 180-182).

### B. Paginated initial load

Replace the eager `getAll()` in the store initializer. Keep two tracks:

```ts
// src/store/task-store.ts
const init = async () => {
  const [active, recentPage] = await Promise.all([
    window.electronAPI.tasks.getActive(),
    window.electronAPI.tasks.getAll({ limit: 100, offset: 0 }),
  ]);
  // Merge: active tasks always present, plus first page of all (which includes the same active tasks).
  const seen = new Set<string>();
  const merged: TaskInfo[] = [];
  for (const t of [...active, ...recentPage]) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    merged.push(t);
  }
  merged.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  set({ tasks: merged, loading: false, loaded: true, hasMore: recentPage.length === 100 });
};
```

Add `hasMore: boolean` to the store state. Wire `loadMoreTasks(offset)` to the history modal's scroll trigger.

### C. Sidebar audit

`TasksList.tsx` filters tasks by paneId-in-current-layout for the "Recent" section. Verify after pagination that the "Recent" set is still correct: a recent completed task whose paneId is in layout should appear, even if it's beyond the first page of loaded tasks. If today's behaviour relies on the full list, add `tasks:getRecent({limit: 50})` or change the filter to query main directly per render.

### D. Retention prune on boot

Extend `TaskManager` constructor to prune old completed/abandoned tasks:

```ts
constructor(dataDir?: string, retentionDays = 90) {
  this.dataDir = dataDir ?? manorDataDir();
  this.retentionDays = retentionDays;
  this.tasks = this.loadState();
  this.pruneOlderThan(this.retentionDays);
}

private pruneOlderThan(days: number): void {
  if (!Number.isFinite(days) || days <= 0) return;
  const cutoff = Date.now() - days * 86_400_000;
  let changed = false;
  for (const [sessionId, task] of this.tasks) {
    if (task.status === "active") continue;
    const completedMs = task.completedAt ? Date.parse(task.completedAt) : 0;
    if (completedMs && completedMs < cutoff) {
      this.tasks.delete(sessionId);
      changed = true;
    }
  }
  if (changed) this.saveState();
}
```

`retentionDays` plumbing: `PreferencesManager` gains a `taskRetentionDays` key (default 90). `app-lifecycle.ts:74` passes it to `new TaskManager(undefined, preferences.taskRetentionDays)`.

### E. One-time prune notice

On the first prune-with-changes after the upgrade, surface a non-blocking toast ("Pruned N old tasks; configure retention in Preferences"). Persist a flag in PreferencesManager so it only fires once per major version.

## Files to touch

- `electron/ipc/tasks.ts` — add `tasks:getActive` (and possibly `tasks:getRecent`).
- `electron/preload.ts` — expose new APIs.
- `src/electron.d.ts` — type the new APIs.
- `electron/task-persistence.ts` — add retention pruning.
- `electron/preferences.ts` — add `taskRetentionDays`.
- `electron/app-lifecycle.ts` — pass retention into TaskManager.
- `src/store/task-store.ts` — switch to paginated init.
- `src/components/sidebar/TasksList.tsx` — verify Recent-section behaviour after pagination.
- `src/components/sidebar/TasksView/TasksView.tsx` — wire scroll-triggered loadMore.

## Tests

- TaskManager: pruneOlderThan with mixed ages; active tasks not touched.
- TaskManager: pruneOlderThan called from constructor; retention=0 disables.
- IPC: `tasks:getActive` returns filtered list, never invokes the sort path.
- Renderer (component test): TasksView scrolls past page boundary, calls loadMoreTasks once.

## Notes

Opus-assigned because the sidebar audit (step C) is non-trivial and the retention semantics need care for users with a long history.
