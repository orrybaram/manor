---
title: Close old task on SessionStart pane replacement
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Close old task on SessionStart pane replacement

In `electron/hook-relay.ts:144-155`, a new `SessionStart` that replaces an existing root session on the same pane deletes the old `SessionState` immediately. If the old task is still in `thinking`/`working`, it becomes an orphan — no session state means no sweep coverage, and the `paneRootSessionMap` bridge from ADR-131 now points at the new session, so the old task's spinner never clears.

See ADR-132 §"Fix 2" for full reasoning.

## What to change

In the `if (eventType === "SessionStart")` block, before deleting `sessionStateMap.get(oldRoot)`, force-apply `Stop` on the old task if it is still in an active state. Gate on `hasBeenActive` so we don't force-close a session that never really ran.

Target shape:

```ts
if (eventType === "SessionStart") {
  const oldRoot = paneRootSessionMap.get(paneId);
  if (oldRoot && oldRoot !== sessionId) {
    const oldState = sessionStateMap.get(oldRoot);
    const oldTask = taskManager.getTaskBySessionId(oldRoot);
    if (
      oldTask &&
      oldState?.hasBeenActive &&
      (oldTask.lastAgentStatus === "thinking" ||
        oldTask.lastAgentStatus === "working")
    ) {
      console.debug(
        `[task-lifecycle] SessionStart replacement: forcing responded on old session ${oldRoot}`,
      );
      if (oldState) {
        oldState.activeSubagents.clear();
        oldState.pendingStopAt = null;
      }
      applyStopForSession(oldRoot);
    }
    console.debug(
      `[task-lifecycle] SessionStart: resetting root session on pane ${paneId} (${oldRoot} → ${sessionId})`,
    );
    paneRootSessionMap.delete(paneId);
    sessionStateMap.delete(oldRoot);
  }
  paneRootSessionMap.set(paneId, sessionId);
  return;
}
```

The existing `console.debug("[task-lifecycle] SessionStart: resetting root session...")` message must remain (preserve existing log). The new force-close debug log is additional.

`applyStopForSession` is already defined in this file — call it directly.

## Files to touch

- `electron/hook-relay.ts` — modify the `SessionStart` branch in `relay()` per above. No other functions change.

Do NOT update tests in this ticket — tests land in ticket 4.
