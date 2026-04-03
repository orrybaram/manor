---
title: Update task name from agent title in main process
status: done
priority: critical
assignee: sonnet
blocked_by: []
---

# Update task name from agent title in main process

When the main process receives `agentStatus` events from the daemon (at `electron/main.ts:225-229`), it currently just forwards them to the renderer. It should also update the persisted task's `name` field when a meaningful title arrives.

## Implementation

### 1. Add title-cleaning utility (`electron/title-utils.ts`)

Create a shared utility with one function:

```typescript
const GENERIC_AGENT_TITLES = new Set(["claude", "claude code", "opencode", "codex"]);

export function cleanAgentTitle(title: string | null | undefined): string | null {
  if (!title) return null;
  const cleaned = title
    .replace(/[\u2800-\u28FF]/g, "")  // braille spinner chars
    .replace(/[✳✻✽✶✢]/g, "")          // done markers
    .trim();
  if (!cleaned) return null;
  if (GENERIC_AGENT_TITLES.has(cleaned.toLowerCase())) return null;
  return cleaned;
}
```

### 2. Update task name on agentStatus events (`electron/main.ts`)

In the `case "agentStatus"` handler (~line 225), after forwarding to the renderer, look up the task by paneId and update its name if currently null:

```typescript
case "agentStatus": {
  mainWindow.webContents.send(
    `pty-agent-status-${event.sessionId}`,
    event.agent,
  );
  // Update persisted task name from agent title
  const cleaned = cleanAgentTitle(event.agent.title);
  if (cleaned) {
    const task = taskManager.getTaskByPaneId(event.sessionId);
    if (task && !task.name) {
      const updated = taskManager.updateTask(task.id, { name: cleaned });
      if (updated) broadcastTask(updated);
    }
  }
  break;
}
```

### 3. Add `getTaskByPaneId` to TaskManager (`electron/task-persistence.ts`)

Add a method to look up a task by its `paneId` field:

```typescript
getTaskByPaneId(paneId: string): TaskInfo | null {
  for (const task of this.tasks.values()) {
    if (task.paneId === paneId) return task;
  }
  return null;
}
```

## Files to touch
- `electron/title-utils.ts` — new file, shared title cleaning utility
- `electron/main.ts` — add title→name update in agentStatus handler (~line 225)
- `electron/task-persistence.ts` — add `getTaskByPaneId` method
