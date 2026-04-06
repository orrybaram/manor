---
title: Keep persisted task name updated from agent title stream
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Keep persisted task name updated from agent title stream

Remove the `!task.name` guard so the persisted task name stays current with the agent's evolving title. This ensures that even after a pane is closed, the task retains the most recent meaningful title.

## What to do

1. In `electron/app-lifecycle.ts` (lines 133-151), the `agentStatus` stream event handler:

**Current code:**
```typescript
const cleaned = cleanAgentTitle(event.agent.title);
if (cleaned) {
  const task = taskManager.getTaskByPaneId(event.sessionId);
  if (task && !task.name) {
    const updated = taskManager.updateTask(task.id, { name: cleaned });
    // ... broadcast
  }
}
```

**Change to:**
```typescript
const cleaned = cleanAgentTitle(event.agent.title);
if (cleaned) {
  const task = taskManager.getTaskByPaneId(event.sessionId);
  if (task && task.name !== cleaned) {
    const updated = taskManager.updateTask(task.id, { name: cleaned });
    // ... broadcast (keep existing broadcast logic)
  }
}
```

The only change is replacing `!task.name` with `task.name !== cleaned` — update whenever the title meaningfully changes, not just the first time.

## Files to touch
- `electron/app-lifecycle.ts` — change `!task.name` to `task.name !== cleaned` on line 137
