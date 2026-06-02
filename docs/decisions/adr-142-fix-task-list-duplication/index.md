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

# ADR-142: Fix task list duplication on session handoff

## Context

Tasks appear duplicated in the sidebar task list: the same logical task shows
twice (commonly one green/active dot plus one that looks finished), and one of
them vanishes when clicked. Confirmed against live data in
`~/Library/Application Support/Manor/tasks.json` — two records with the same
name, both `status:"active"`, different ids/`agentSessionId`, one with a pane and
one with `paneId:null`.

Two facts collide:

1. **A finished turn keeps `status:"active"`.** `applyStopForSession`
   (`electron/hook-relay.ts:259-262`) sets `lastAgentStatus:"responded"` but
   leaves `status:"active"`. Only `SessionEnd → MarkCompleted` flips `status` to
   `"completed"`. So a task that has responded but whose session never emitted
   `SessionEnd` stays `status:"active"`.

2. **A new `session_id` mints a new record.** Tasks are keyed by
   `agentSessionId` (`electron/task-persistence.ts`). When the agent's session id
   changes for a pane — `/clear`, resume, or compaction — `transitionSession`
   sees `existingTask=null` and emits `CreateTask`
   (`electron/hook-relay-transition.ts:226-233`), producing a second record for
   the same pane.

`CreateTask` already tries to retire the previous pane owner
(`electron/hook-relay-effects.ts:95-98`):
`getTaskByPaneId(pane) → updateTask({ paneId: null })`. It nulls `paneId` but
**never changes `status`**, so the old record stays `status:"active"`. The
renderer shows every `status==="active"` task regardless of pane
(`src/components/sidebar/TasksList.tsx:82-90`), so both records render → the
duplicate. The orphaned record (`paneId:null`) can't be navigated to
(`navigateToTask` early-returns at the `task.paneId` guard), which is the
"disappears on click" secondary symptom as the layout re-renders.

The existing `ForceCloseOldSession` path only retires the old task when it is
*stuck-active* (`thinking`/`working`/`requires_input`), so a `responded` task
slips through.

## Decision

Two changes — a root fix in the relay effect applier plus a defense-in-depth
guard in the renderer.

1. **Retire the previous pane owner's status on handoff.** In the `CreateTask`
   effect (`electron/hook-relay-effects.ts`), when `getTaskByPaneId` finds a
   prior task for the pane, mark it completed and broadcast it — not just null
   its `paneId`. Use the existing `updateTask` on `ITaskManager` (no new method):

   ```ts
   const prevPaneTask = deps.taskManager.getTaskByPaneId(effect.paneId);
   if (prevPaneTask) {
     const retired = deps.taskManager.updateTask(prevPaneTask.id, {
       paneId: null,
       status: "completed",
       completedAt: new Date().toISOString(),
     });
     deps.unseenRespondedTasks.delete(prevPaneTask.id);
     deps.unseenInputTasks.delete(prevPaneTask.id);
     if (retired) deps.broadcastTask(retired);
   }
   ```

   This mirrors what `MarkCompleted` would have done had `SessionEnd` fired, and
   the broadcast makes the renderer drop the stale row live (no reload needed).

2. **Hide orphaned active tasks in the renderer.** A live task always owns a
   pane, so an `active` task with `paneId == null` is a stranded record. Tighten
   the `visibleTasks` filter in `src/components/sidebar/TasksList.tsx` so an
   active task only shows when it still has a `paneId`:

   ```ts
   tasks.filter(
     (t) =>
       (t.status === "active" && t.paneId != null) ||
       (t.paneId != null && activePaneIds.has(t.paneId)),
   )
   ```

   This is harmless even with fix (1) in place (a stranded active task can't be
   navigated to anyway) and protects against any other path that leaves an
   orphan.

3. **Regression test** at the relay seam (`relay-subagent-tracking.test.ts`,
   which drives the real `relay()` over the fake `ITaskManager`): a second
   session reusing a pane that already had a task results in exactly one
   `status:"active"` record for that pane.

## Consequences

- **Better:** the common `/clear`/resume/compaction flow no longer strands a
  duplicate active record; the old task moves cleanly to completed history. The
  renderer guard closes the class of "orphan active" bugs regardless of cause.
- **Behavior change:** a handed-off task is now recorded as `completed` (with a
  `completedAt`) rather than lingering as `active`. This is the intended
  lifecycle; it also means it becomes eligible for retention pruning like any
  other completed task.
- **Risk:** if `getTaskByPaneId` ever returns a *different* live task than the
  one being replaced, we'd complete the wrong task. This matches the existing
  pre-fix behavior (it already nulled that task's paneId), so the blast radius is
  unchanged — we only add a status flip on the same record.
- **Edge:** completing-on-handoff sets `completedAt`, which interacts with
  pruning; acceptable since these are genuinely finished sessions.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
