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

# ADR-132: Close remaining gaps in stuck-working recovery

## Context

ADR-130 added the stale-`Stop` sweep (`pendingStopAt` branch) and ADR-131 added the stale-active sweep plus the `AgentDetector → applyStopForSession` bridge. Users still report agent status spinners that never clear even after the underlying task is clearly over.

Code audit of `electron/hook-relay.ts`, `electron/app-lifecycle.ts`, and `electron/terminal-host/agent-detector.ts` surfaces three remaining failure modes, all of which bypass the existing safety nets.

### Gap 1 — `SubagentStop` tracking is gated on `ACTIVE_STATUSES` (`electron/hook-relay.ts:170-183`)

```ts
if (ACTIVE_STATUSES.has(status)) {
  sessionState.hasBeenActive = true;

  if (eventType === "SubagentStart") {
    const id = toolUseId ?? `__fallback_${sessionState.activeSubagents.size}`;
    sessionState.activeSubagents.add(id);
  } else if (eventType === "SubagentStop") {
    if (toolUseId) {
      sessionState.activeSubagents.delete(toolUseId);
    } else { /* ... */ }
  }
  // ...
}
```

`SubagentStop` events are terminal — the subagent has finished and its `status` is normally `complete` or `idle`, not an active status. Because the add/remove block lives inside `if (ACTIVE_STATUSES.has(status))`, the `.delete()` at line 178 **never runs** for a real terminal `SubagentStop`. The subagent sits in `activeSubagents` forever, which then blocks the parent `Stop` at line 245 (`pendingStopAt` is set, but the task stays `working` until the 15s stale-stop sweep rescues it — or never, if subsequent activity keeps refreshing `lastHookEventAt`).

Concrete scenario: a turn that used a Task-dispatched subagent (common in this repo) reliably reaches a state where the parent can never `Stop` cleanly. The stale-stop sweep does catch most of these 15–25s later, but under sustained hook activity (multiple turns, stream updates) `lastHookEventAt` gets refreshed and the idle-gate never opens.

### Gap 2 — Old session/task orphaned on `SessionStart` replacement (`electron/hook-relay.ts:144-155`)

```ts
if (eventType === "SessionStart") {
  const oldRoot = paneRootSessionMap.get(paneId);
  if (oldRoot && oldRoot !== sessionId) {
    paneRootSessionMap.delete(paneId);
    sessionStateMap.delete(oldRoot);
  }
  paneRootSessionMap.set(paneId, sessionId);
  return;
}
```

When a new agent session starts on a pane that was already hosting one (e.g. `/clear`, `claude --resume`, or the CLI re-exec'ing itself), the old `SessionState` is discarded **before** any check that the old task is in a terminal state. If the old task's `lastAgentStatus` is `thinking`/`working`, it is now an orphan:

- No entry in `sessionStateMap` for its `agentSessionId`.
- `sweepStaleSessions()` iterates `sessionStateMap` — orphans are invisible.
- The `AgentDetector → applyStopForSession` bridge (ADR-131) uses `paneRootSessionMap`, which now points at the **new** session — the old task's sessionId is unreachable from the pane.

The old task spins forever.

### Gap 3 — No recovery path for tasks whose session state is already gone

More generally, any path that drops `sessionStateMap[sessionId]` while `task.lastAgentStatus` is still active leaves the task unrecoverable. Sources of this condition:

- Gap 2 above.
- `SessionEnd` handling (line 264) deletes the session state; if `SessionEnd` fires before the task's final state is written (race with the daemon shutting down), we can land in an inconsistent state.
- Main-process restart while tasks are in-flight: on boot, tasks from the prior process are rehydrated with whatever `lastAgentStatus` was last persisted, but no `SessionState` exists for them. Nothing will ever move them to a terminal state.

### What we intentionally do NOT change

- `src/hooks/useTaskDisplay.ts` — the derivation logic is correct for clean inputs. Fixing the UI would mask the real bug.
- `src/store/task-store.ts` receive logic — the status-change branch gates pulse/toast only; the persisted state still updates. Not the spinning bug.
- `AgentDetector.completeTimer` (`agent-detector.ts:364-374`) — 5 s linger is short but only affects pane-level status, and the bridge already handles the handoff to task state.

## Decision

Three small, independent fixes in `electron/hook-relay.ts`, each with a focused test. All flow into the existing `applyStopForSession()` terminal path so the renderer/UI contract is unchanged.

### Fix 1 — Track `SubagentStart`/`SubagentStop` regardless of event status

Move the subagent add/remove block out of the `if (ACTIVE_STATUSES.has(status))` branch. Subagent lifecycle is orthogonal to the event's payload status — `SubagentStart`/`SubagentStop` event names are already authoritative.

```ts
// Runs before the ACTIVE_STATUSES branch, unconditional on status:
if (eventType === "SubagentStart") {
  const id = toolUseId ?? `__fallback_${sessionState.activeSubagents.size}`;
  sessionState.activeSubagents.add(id);
} else if (eventType === "SubagentStop") {
  if (toolUseId) {
    sessionState.activeSubagents.delete(toolUseId);
  } else {
    const first = sessionState.activeSubagents.values().next().value;
    if (first !== undefined) sessionState.activeSubagents.delete(first);
  }
}
```

`hasBeenActive` remains set only inside `ACTIVE_STATUSES` — that guard is still correct (we should not treat a bare `SubagentStart` with an empty/idle status as "the agent became active"). Only the bookkeeping for open subagents moves.

After this fix, a terminal `SubagentStop` deterministically clears the pending-Stop block, so parent `Stop` applies immediately instead of waiting on the 15 s sweep.

### Fix 2 — Close the old task on `SessionStart` replacement

Before deleting the old session state, force-apply `Stop` on the old task if it's still active:

```ts
if (eventType === "SessionStart") {
  const oldRoot = paneRootSessionMap.get(paneId);
  if (oldRoot && oldRoot !== sessionId) {
    const oldState = sessionStateMap.get(oldRoot);
    const oldTask = taskManager.getTaskBySessionId(oldRoot);
    if (
      oldTask &&
      oldState?.hasBeenActive &&
      (oldTask.lastAgentStatus === "thinking" || oldTask.lastAgentStatus === "working")
    ) {
      if (oldState) {
        oldState.activeSubagents.clear();
        oldState.pendingStopAt = null;
      }
      applyStopForSession(oldRoot);
    }
    paneRootSessionMap.delete(paneId);
    sessionStateMap.delete(oldRoot);
  }
  paneRootSessionMap.set(paneId, sessionId);
  return;
}
```

Gated on `hasBeenActive` and active `lastAgentStatus` to avoid touching tasks that are already terminal or never really ran.

### Fix 3 — Orphan-task sweep

Extend `sweepStaleSessions()` with a second pass that scans tasks (not sessions) and force-recovers any active task whose `agentSessionId` has no corresponding `SessionState`. This closes the window for every class of orphan (Gap 2 residual, `SessionEnd` races, post-restart rehydration, and any future path that drops session state early).

The sweep needs a way to enumerate active tasks. Add one method to `ITaskManager`:

```ts
getActiveTasks(): TaskInfo[];
```

Implement on `TaskManager` (filter `status === "active"`). Then in `sweepStaleSessions`:

```ts
const ORPHAN_TASK_MS = STALE_ACTIVE_MS; // 60s — same conservative threshold

for (const task of taskManager.getActiveTasks()) {
  if (!task.agentSessionId) continue;
  if (sessionStateMap.has(task.agentSessionId)) continue;
  if (task.lastAgentStatus !== "thinking" && task.lastAgentStatus !== "working") continue;

  const activatedMs = task.activatedAt ? Date.parse(task.activatedAt) : 0;
  if (!activatedMs || Date.now() - activatedMs < ORPHAN_TASK_MS) continue;

  console.debug(`[task-lifecycle] orphan-task sweep: forcing responded on ${task.agentSessionId}`);
  applyStopForSession(task.agentSessionId);
}
```

Gate on `activatedAt` age so we don't race a task's very first creation. Share the 60 s threshold with `STALE_ACTIVE_MS` — same "agent actually went quiet long enough" semantic.

### Tests

Extend `electron/__tests__/relay-subagent-tracking.test.ts`:

- **Fix 1**: `SubagentStart` fires (status `working`), then `SubagentStop` fires with a terminal status (e.g. `complete`). `activeSubagents` should be empty. Parent `Stop` should apply immediately (not set `pendingStopAt`).
- **Fix 2**: Open a session, drive it to `working`, then deliver `SessionStart` with a new `sessionId` on the same pane. The old task must be transitioned to `responded`; the new session must have a clean `SessionState`.
- **Fix 3**: Seed a task directly in the fake `TaskManager` with `status: "active"`, `lastAgentStatus: "working"`, `activatedAt` > `STALE_ACTIVE_MS` in the past, and **no** entry in `sessionStateMap`. Call `sweepStaleSessions()`. Task must transition to `responded`.
- **Fix 3 negatives**: a task younger than the threshold — no-op. A task with a live `SessionState` — handled by existing branches, orphan pass no-ops. A task already in a terminal state — no-op.

## Consequences

**Better**:
- Subagent-heavy turns no longer park in `working` for 15+ s after completion.
- Pane re-use (`/clear`, `claude --resume`) no longer leaks spinning tasks.
- Main-process restart with in-flight tasks self-heals within one sweep interval.
- Belt-and-suspenders: Fix 3 catches anything Fix 1/2 miss, plus any future regression that drops session state.

**Tradeoffs**:
- `getActiveTasks()` adds one new method on `ITaskManager` and `TaskManager`. The list is small in practice (active tasks are few) and only walked once per 10 s sweep.
- `ORPHAN_TASK_MS = 60_000` means up to 70 s between orphan creation and recovery. Acceptable — the UI still spins during that window, but eventually heals without user action.

**Risks**:
- Fix 1 relies on `SubagentStart`/`SubagentStop` event names being correctly labelled by the hook script. If they were ever mislabelled, an unmatched `SubagentStop` could underflow the set — guarded by the existing `values().next().value` fallback which no-ops on empty.
- Fix 2 could double-fire `applyStopForSession` if the old session's `Stop` arrives simultaneously with a new `SessionStart`. `applyStopForSession` is idempotent (already setting `lastAgentStatus: "responded"`) — second call produces no visible change.
- Fix 3's `activatedAt` gate is important: without it we could race a real SessionStart during its first hook.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
