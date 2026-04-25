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

# ADR-138: Agent system cleanup

## Context

The agent/task system carries enough cumulative cruft that it shows up in the architecture audit. None of these items is a user-visible bug; together they raise the cost of every future change in this area.

### Item 1 — `tasks:get` is O(n) with a sort

`ipc/tasks.ts:32-36`:
```ts
ipcMain.handle("tasks:get", (_event, taskId: string) => {
  assertString(taskId, "taskId");
  const all = taskManager.getAllTasks();
  return all.find((t) => t.id === taskId) ?? null;
});
```

`taskManager.getAllTasks()` does an `Array.from(map.values())` followed by a sort by `createdAt` (`task-persistence.ts:128-131`). Every `tasks:get` call walks all tasks twice — once to materialize, once to find. With a thousand tasks this is still fast in absolute terms (<1 ms), but it's gratuitous work for a single-task lookup, and `tasks:get` is called from notification-click handlers where we already pay for an IPC round-trip.

### Item 2 — `unlinkPane` is dead code

`task-persistence.ts:195-208` defines `unlinkPane(paneId)` that nullifies `paneId` on every task matching the pane. Audit shows zero callers (`grep "unlinkPane" electron src` returns only the definition site). The relay's "task-by-pane already exists" branch at `hook-relay.ts:207-210` inlines its own `updateTask({ paneId: null })` rather than calling this helper.

### Item 3 — `claudeSessionId` migration is permanently warm

`loadState()` at `task-persistence.ts:53-57` migrates legacy `claudeSessionId → agentSessionId` on every load. Useful at the time the rename happened; redundant now for any user who has launched the migrated build at least once. The branch is cheap (per-task), but it's pollution in the hot load path and grows the test surface.

### Item 4 — `AgentDetector` heuristics duplicate hook signal

`electron/terminal-host/agent-detector.ts` (395 lines) runs heuristic detection on session stdout: title-string watching (OSC 0/2), process-name polling, banner regex matching to derive `AgentState.kind` and `.status`. It dates from before the hook system was authoritative. Hook events now flow through `relayAgentHook(paneId, status, kind)` and are the source of truth.

The detector is still useful for:
- Sessions running an agent that doesn't (yet) have hook integration.
- Detecting that the agent process *exited* (hook system has SessionEnd, but only if the agent shuts down cleanly — kill -9 produces no SessionEnd).
- The OSC 0/2 title that becomes the task name.

But large portions of its banner-matching and process-polling logic are redundant with hook-driven status. Untangling cleanly without breaking the agent-detector→relay bridge (`hook-relay.ts:361-381`) is non-trivial; the goal of this ticket is to *audit and document*, not rewrite, unless the audit surfaces dead branches.

### Item 5 — Index by `id` for fast lookup

Closely related to Item 1: `TaskManager` indexes by `agentSessionId` (Map key). Lookups by `id` walk all tasks (`updateTask:96`, `setTaskStatus:144`, `deleteTask:185`). Adding a secondary `Map<id, agentSessionId>` index makes all of these O(1).

## Decision

Five small, mostly mechanical changes. Item 4 is the only one that requires judgement.

### Change 1 — `tasks:get` uses a direct index lookup

Add `getTaskById(id)` to `TaskManager` and use it in the IPC handler.

```ts
// electron/task-persistence.ts
private idIndex: Map<string, string> = new Map(); // taskId → agentSessionId

// Build during loadState (after the migration loop):
this.idIndex.clear();
for (const task of this.tasks.values()) {
  this.idIndex.set(task.id, task.agentSessionId);
}

// Maintain on every Map mutation:
// - createTask: idIndex.set(task.id, task.agentSessionId)
// - updateTask: if agentSessionId changed (it shouldn't), update both
// - deleteTask: idIndex.delete(task.id)

getTaskById(id: string): TaskInfo | null {
  const sessionId = this.idIndex.get(id);
  if (!sessionId) return null;
  return this.tasks.get(sessionId) ?? null;
}
```

```ts
// electron/ipc/tasks.ts
ipcMain.handle("tasks:get", (_event, taskId: string) => {
  assertString(taskId, "taskId");
  return taskManager.getTaskById(taskId);
});
```

Update `updateTask`, `setTaskStatus`, `deleteTask` to use `getTaskById` internally — drops three more O(n) scans.

### Change 2 — Remove `unlinkPane`

Delete the method outright (`task-persistence.ts:195-208`). No callers; existing callers use inline `updateTask({ paneId: null })`.

### Change 3 — Drop `claudeSessionId` migration after one warm-up release

Two-step:

1. **Land first.** Add a startup pass (separate from `loadState`) that does the migration on disk: `if any task has claudeSessionId, rewrite tasks.json once`. After that pass, `loadState` skips the migration block entirely. The release notes mention "migrated legacy task records".
2. **Land later.** Delete the migration code entirely after one shipped release. Already-running users will have been migrated on first boot of the prior release.

The split makes the deletion safe even if a user skips a release.

For now, ticket-3 only does step 1.

### Change 4 — Audit `AgentDetector` for dead branches

Read `electron/terminal-host/agent-detector.ts` end-to-end with the question: *given hook events drive status authoritatively, what does this code still need to do?*

Output: a short note (in the ticket's notes section) listing branches that are pure dead code given hook authority, branches that are still load-bearing for hook-less sessions, and branches that are belt-and-suspenders backups for hook misses.

If the audit surfaces clearly dead code (e.g. status enum branches that only fire when no hook ever arrived AND the user is running a known-hooked agent), delete it as part of the same ticket. If the audit is inconclusive, file a follow-up.

This is explicitly NOT a rewrite of the detector. The detector→relay bridge (`notifyAgentDetectorGone` in `hook-relay.ts:361-381`) is load-bearing.

### Change 5 — Documentation

Add a short comment block at the top of `task-persistence.ts` explaining the dual-key invariant (`agentSessionId` as Map key, `id` as the public stable handle, `paneId` as the optional layout link). Same for the relay: a paragraph on what `paneRootSessionMap` vs `sessionStateMap` are for and the namespace boundary between agent UUIDs and pane IDs (the bug from ADR-133).

## Consequences

**Better:**
- `tasks:get` is O(1). Same for `updateTask`, `setTaskStatus`, `deleteTask`.
- Dead code removed; future changes don't have to read past it.
- Migration pollution shrinks.
- Detector behaviour is documented; future audits start from a known baseline.

**Tradeoffs:**
- Maintaining the `idIndex` adds a few lines to every Map mutation site. Easy to drift if a future patch only touches `this.tasks` — guard with a runtime invariant check in dev or, better, a unit test that verifies `idIndex.size === tasks.size` after every public method.
- Migration deletion is staged (this ADR only does step 1); the actual code-delete waits a release. Tracked in the ticket.

**Risks:**
- If `agentSessionId` is ever updated on a task (it shouldn't be — the IPC allowlist from ADR-136 ticket 1 prevents it from the renderer, and main writes it only at create time), the `idIndex` would need updating. Add an assertion in `updateTask` that `agentSessionId` is never in the update partial.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
