---
title: Apply pending Stop before SessionEnd transitions to completed
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Apply pending Stop before SessionEnd transitions to completed

When `pendingStopAt !== null` (Stop was received but blocked by active subagents) and `SessionEnd` arrives before the stale-stop sweep clears the block, the `SessionEnd` arm at `electron/hook-relay.ts:269-283` deletes the session state and transitions the task straight to `completed` without ever firing the deferred Stop. Two visible consequences:

1. `unseenRespondedTasks` never gains the task id, so `maybeSendNotification(..., "responded", ...)` is never called. The user misses the "task responded" notification on a fast Stop→SessionEnd.
2. `lastAgentStatus` jumps from `working` (or `thinking`) directly to `complete`, skipping the `responded` transition. Any UI that pulses on `responded` won't.

See ADR-135 §"Change 3" for full reasoning.

## What to change

In the `SessionEnd` arm of `relay()`, fire `applyStopForSession` first if a Stop was pending:

```ts
} else if (eventType === "SessionEnd") {
  if (sessionState.pendingStopAt !== null) {
    sessionState.activeSubagents.clear();
    sessionState.pendingStopAt = null;
    applyStopForSession(sessionId);
    // applyStopForSession mutated the task; re-fetch so the completed transition
    // sees the updated lastAgentStatus.
    task = taskManager.getTaskBySessionId(sessionId);
  }
  if (task) {
    task = taskManager.updateTask(task.id, {
      lastAgentStatus: "complete",
      status: "completed",
      completedAt: new Date().toISOString(),
    });
    if (task) {
      unseenRespondedTasks.delete(task.id);
      unseenInputTasks.delete(task.id);
      broadcastTask(task);
    }
  }
  sessionStateMap.delete(sessionId);
  paneRootSessionMap.delete(paneId);
}
```

Order matters: applyStopForSession → updateTask(completed) → cleanup. The `unseenRespondedTasks.delete` after the completed transition is unchanged — it's correct to clear it once the task is fully complete.

## Files to touch

- `electron/hook-relay.ts` — extend the SessionEnd arm with the pending-Stop drain.

## Tests

Extend `electron/__tests__/relay-subagent-tracking.test.ts` or a sibling:

1. Drive a session into `working`, fire `SubagentStart`, fire `Stop` (pendingStopAt is set), then immediately fire `SessionEnd`. Assert:
   - `maybeSendNotification` was called with `(task, "working", "responded")`.
   - `unseenRespondedTasks` was added then removed (or was added inside applyStopForSession; either way the notification spy fired).
   - Final task state: `status: "completed"`, `lastAgentStatus: "complete"`.
2. Negative: SessionEnd without a pending Stop — behaviour identical to today.
