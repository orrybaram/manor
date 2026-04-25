---
type: adr
status: accepted
database:
  schema:
    status:
      type: select
      options: [todo, in-progress, review, done]
      default: todo
    priority:
      type: select
      options: [critical, high, medium, low]
    assignee:
      type: select
      options: [opus, sonnet, haiku]
  defaultView: board
  groupBy: status
---

# ADR-136: Tighten the renderer ↔ main task contract

## Context

The renderer and main process share state about tasks via four mechanisms — `tasks:*` IPC handlers, the `task-updated` broadcast, the unseen-flag Sets in main, and the `seenTaskIds` Set in `useTaskStore`. Each was introduced incrementally; the contract between them is now loose enough to produce four distinct user-visible defects:

### Defect 1 — `tasks:update` is an unbounded write surface

```ts
ipcMain.handle("tasks:update", (_event, taskId: string, updates: Record<string, unknown>) => {
  return taskManager.updateTask(taskId, updates);
});
```
(`electron/ipc/tasks.ts:38-44`)

Any field on `TaskInfo` is writeable from the renderer except `id` (preserved by `TaskManager.updateTask` itself). That includes `agentSessionId`, which is the Map key. A buggy renderer call could silently swap a task's identity out from under the relay; nothing in the IPC layer prevents it.

### Defect 2 — Initial load fetches every task

`useTaskStore` initializer (`src/store/task-store.ts:44-50`) calls `getAll()` with no opts on app boot. With no retention, `tasks.json` grows forever. `TasksView/TasksView.tsx` pages client-side from the already-loaded array.

`tasks:getAll` itself sorts by `createdAt` *and then* slices for `offset`/`limit` (`task-persistence.ts:128-138`), so the full sort runs even on a paginated request. Acceptable when N is small; not when it's tens of thousands.

### Defect 3 — Unseen-flag bookkeeping is dual-sourced and drift-prone

Main keeps `unseenRespondedTasks` and `unseenInputTasks` (Sets). Renderer keeps `seenTaskIds` (Set). Sync goes via `tasks:markSeen` IPC (`ipc/tasks.ts:55-60`), but renderer also clears its own `seenTaskIds` on status change (`store/task-store.ts:114-120`) without telling main. The dock badge count is computed from main's Sets; under rapid status flips (`responded` → `requires_input` → `responded`) main can over-count because the renderer's local "seen" reset doesn't propagate.

Source-of-truth confusion is the underlying issue. The current code has main own the *count* and renderer own the *visual seen flag*; they should agree but the sync is one-way.

### Defect 4 — `navigateToTask` is a four-step Zustand mutation

```ts
appStore.selectProject(projectId);
appStore.selectWorkspace(workspaceIndex);
appStore.selectTab(tabId);
appStore.focusPane(paneId);
```
(`src/utils/task-navigation.ts`, four discrete `setState` calls)

Each call triggers a renderer subscription pass. Intermediate states (project selected but no workspace, tab selected but no pane) are observable and have caused subtle flicker bugs in panes that subscribe to project + workspace simultaneously. Comments in the file imply atomicity that doesn't exist.

## Decision

Four changes, all on the renderer/main boundary. They cluster naturally because they share data (tasks) and audience (the renderer).

### Change 1 — Allowlist `tasks:update`

Replace the generic partial with a typed updater that exposes only the fields the renderer is allowed to change. Internal lifecycle fields (`status`, `agentSessionId`, `lastAgentStatus`, `activatedAt`, `completedAt`, `resumedAt`) are owned by main; the renderer never has a legitimate reason to write them.

```ts
// In electron/ipc/tasks.ts
type RendererTaskUpdate = Partial<{
  name: string | null;
  // future: priority, tags, etc.
}>;

function isRendererTaskUpdate(u: unknown): u is RendererTaskUpdate {
  if (!u || typeof u !== "object") return false;
  const allowed = new Set(["name"]);
  for (const k of Object.keys(u as object)) {
    if (!allowed.has(k)) return false;
  }
  return true;
}

ipcMain.handle("tasks:update", (_event, taskId: string, updates: unknown) => {
  assertString(taskId, "taskId");
  if (!isRendererTaskUpdate(updates)) {
    throw new Error(`tasks:update: rejected unsafe field set: ${JSON.stringify(Object.keys(updates as object))}`);
  }
  return taskManager.updateTask(taskId, updates);
});
```

`TaskManager.updateTask` retains its full Partial<TaskInfo> signature — the relay needs that. Only the *IPC handler* tightens.

The `electronAPI.tasks.update` type in `src/electron.d.ts` and `electron/preload.ts:325` (or wherever it lives) is narrowed to `RendererTaskUpdate`.

Audit existing renderer callers; if any currently write a non-`name` field, fix them or open a sibling ticket.

### Change 2 — Pagination + retention

Two sub-changes:

**2a. Pagination on initial load.** Replace the unscoped `getAll()` in the store with a paged load. Default page size 100 (covers the sidebar + first screen of the history modal). Lazy-load subsequent pages on history-modal scroll.

```ts
// src/store/task-store.ts
window.electronAPI?.tasks
  .getAll({ limit: 100, offset: 0 })
  .then((tasks) => set({ tasks, loading: false, loaded: true, hasMore: tasks.length === 100 }));
```

The store gains a `hasMore: boolean` field and `loadMoreTasks` is wired to the history modal's scroll-into-view.

Active tasks are a special case — the sidebar always wants them all. Add `tasks:getActive` IPC that returns *just* `getActiveTasks()` without the slice/sort. Two-track loading:
- On boot: `tasks:getActive` (small) for the sidebar; `tasks:getAll({limit:100})` (lazy on idle) for the history-modal first page.

**2b. Retention.** Add a config setting `taskRetentionDays` (default 90) and prune on TaskManager construction. The prune walks `tasks` and removes any `status !== "active"` entry whose `completedAt` is older than the threshold.

```ts
// In TaskManager constructor, after loadState():
this.pruneOlderThan(this.retentionDays);

private pruneOlderThan(days: number): void {
  if (!Number.isFinite(days) || days <= 0) return;
  const cutoff = Date.now() - days * 86_400_000;
  let changed = false;
  for (const [sessionId, task] of this.tasks) {
    if (task.status === "active") continue;
    const completed = task.completedAt ? Date.parse(task.completedAt) : 0;
    if (completed && completed < cutoff) {
      this.tasks.delete(sessionId);
      changed = true;
    }
  }
  if (changed) this.saveState();
}
```

Setting lives in `PreferencesManager`; renderer can override per-user.

### Change 3 — Single source of truth for "unseen"

Make main authoritative. Renderer's `seenTaskIds` becomes a *cache* of main's state, populated by:
1. The initial `tasks:getAll` response (extend it to return the unseen Sets).
2. The `task-updated` broadcast (extend its payload to include the seen flag for the affected task).
3. The `tasks:markSeen` round-trip (broadcast back so other future consumers stay in sync).

Concretely:
- Extend `task-updated` channel from `(task: TaskInfo)` to `(task: TaskInfo, seen: { responded: boolean; requires_input: boolean })`. The flags reflect "is this task unseen on the responded/input axes" at the moment of the broadcast.
- Renderer reads the flags directly to drive pulse/animation; never resets them locally on status change.
- Drop the renderer's local "clear seen on status change" branch (`store/task-store.ts:115-120`). Status change triggers a fresh broadcast from main with fresh flags.

Trade: an extra round-trip on the boot load. Cheap.

### Change 4 — Atomic `navigateToTask`

Add a single `navigateToContext(ctx)` action on `useAppStore` that does the four mutations in one `set(state => ...)` call. `navigateToTask` then constructs the context and calls one action.

```ts
// src/store/app-store.ts
navigateToContext: (ctx: { projectId: string; workspaceIndex: number; tabId: string; paneId: string }) =>
  set(state => {
    // existing select-* logic, but composed inside one set call.
    // produce the next state directly; do not call other store actions
    // (those would re-invoke set and break atomicity).
  }),
```

Refactor `navigateToTask` to call this single action. The four prior `selectProject`/`selectWorkspace`/`selectTab`/`focusPane` actions remain on the store for direct callers (keyboard shortcuts, command palette) — only the navigation flow uses the composed action.

## Consequences

**Better:**
- Renderer can't accidentally rewrite task identity (Change 1).
- Boot scales to thousands of tasks; history modal stays fast (Change 2).
- Dock-badge count agrees with renderer pulse state under rapid flips (Change 3).
- Navigate-to-task no longer flickers through intermediate states (Change 4).

**Tradeoffs:**
- Change 1 narrows what the renderer can write. If a future feature needs to set lifecycle fields from the renderer, that PR has to widen the allowlist deliberately — that's a feature, not a bug.
- Change 2's retention default of 90 days will visibly trim long-running users' history on first launch after the upgrade. Surface a one-time toast ("Pruned N tasks older than 90 days; configure in Preferences") so the deletion isn't silent.
- Change 3 widens the `task-updated` payload — a small backwards-compat hop for anyone with an old preload. Acceptable: preload + renderer ship together.
- Change 4 introduces a coupling: `navigateToContext` knows about project/workspace/tab/pane in one place. That's the same coupling that already exists implicitly across the four-call sequence; making it explicit improves auditability.

**Risks:**
- Pagination: if the sidebar's "Recent" section logic depends on having all tasks loaded (e.g. it filters tasks by paneId-still-in-layout from the *full* set), the paged load could miss recent completed tasks beyond the first page. Audit `TasksList.tsx` carefully — likely needs to consume `tasks:getActive` plus a small `tasks:getRecent({limit: 50})` rather than slicing the loaded array.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
