---
title: Make main authoritative for unseen flags
status: done
priority: medium
assignee: opus
blocked_by: []
---

# Make main authoritative for unseen flags

Main keeps `unseenRespondedTasks` and `unseenInputTasks` (Sets) for the dock badge. Renderer keeps `seenTaskIds` (Set) for pulse animation. Sync goes via `tasks:markSeen`, but the renderer also clears its `seenTaskIds` on status change (`src/store/task-store.ts:115-120`) without telling main. Under rapid status flips main can over-count; under transient renderer state main can under-count.

See ADR-136 §"Change 3" for full reasoning.

## What to change

Make the renderer a *cache* of main's state.

### A. Extend the broadcast payload

Change `task-updated` from `(task: TaskInfo)` to `(task: TaskInfo, unseen: { responded: boolean; requires_input: boolean })`. The flags reflect main's state at the moment of the broadcast.

In `electron/app-lifecycle.ts:322-335` and the other `broadcastTask` call sites:

```ts
function broadcastTask(task: TaskInfo): void {
  const unseen = {
    responded: unseenRespondedTasks.has(task.id),
    requires_input: unseenInputTasks.has(task.id),
  };
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    try {
      mainWindow.webContents.send("task-updated", task, unseen);
    } catch { /* ignore */ }
  }
  updateDockBadge();
}
```

### B. Extend `tasks:getAll` return shape

Return `{ tasks: TaskInfo[]; unseen: { responded: string[]; requires_input: string[] } }` so the initial load primes the renderer's cache. (Or keep the existing return and add `tasks:getUnseen()` as a separate call; pick the simpler one.)

### C. Renderer drops local resets

In `src/store/task-store.ts`:

- Remove the local clear at lines 115-120 (the "clear seen flag when status changes" branch).
- Remove the renderer's `seenTaskIds` Set entirely. Replace with `unseenRespondedTaskIds: Set<string>` and `unseenInputTaskIds: Set<string>` populated from the broadcast/initial load.
- `markTaskSeen(id)` calls `tasks:markSeen` IPC and waits for the next broadcast (or optimistically clears locally and reconciles on broadcast).

UI components that read `seenTaskIds` (probably `AgentDot` and `TasksList`) consume the new Sets directly. Update the pulse predicate to:

```ts
const shouldPulse =
  (task.lastAgentStatus === "responded" && unseenRespondedTaskIds.has(task.id)) ||
  (task.lastAgentStatus === "requires_input" && unseenInputTaskIds.has(task.id));
```

### D. `tasks:markSeen` re-broadcasts

After `tasks:markSeen` mutates main's Sets (`electron/ipc/tasks.ts:55-60`), trigger a `task-updated` broadcast for that task with fresh flags so the renderer cache stays current.

## Files to touch

- `electron/app-lifecycle.ts` — extend broadcastTask payload.
- `electron/ipc/tasks.ts` — extend getAll return; broadcast on markSeen.
- `electron/preload.ts` and `src/electron.d.ts` — new types.
- `src/store/task-store.ts` — replace `seenTaskIds` with two Unseen sets; remove local clear.
- `src/components/ui/AgentDot/AgentDot.tsx` and `src/components/sidebar/TasksList.tsx` — update consumers.

## Tests

- Status-flip storm: rapid `responded` → `requires_input` → `responded` produces consistent dock badge count and consistent renderer pulse.
- Mark seen → next status update arriving from main reflects fresh flags (re-pulse on subsequent response).
- Boot: renderer's Sets match main's exactly after initial load.

## Notes

Opus-assigned — this rewires the renderer's reactivity. The shape change ripples through the broadcast type, the store, and the AgentDot component. Easy to introduce subtle UI regressions if not done carefully.
