---
title: Scope toast visibility check to active workspace
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Scope toast visibility check to active workspace

In `src/store/task-store.ts`, the `receiveTaskUpdate` function's visibility check (lines 122-138) iterates all workspace sessions. Replace it with a check scoped to the active workspace only.

## Changes

Replace this block (lines 122-138):

```typescript
const appState = useAppStore.getState();
let isAlreadyVisible = false;
if (task.paneId != null) {
  for (const ws of Object.values(appState.workspaceSessions)) {
    const activeSession = ws.sessions.find(
      (s) => s.id === ws.selectedSessionId,
    );
    if (
      activeSession &&
      allPaneIds(activeSession.rootNode).includes(task.paneId)
    ) {
      isAlreadyVisible = true;
      break;
    }
  }
}
```

With:

```typescript
const appState = useAppStore.getState();
let isAlreadyVisible = false;
if (task.paneId != null && appState.activeWorkspacePath) {
  const ws = appState.workspaceSessions[appState.activeWorkspacePath];
  if (ws) {
    const activeSession = ws.sessions.find(
      (s) => s.id === ws.selectedSessionId,
    );
    if (
      activeSession &&
      allPaneIds(activeSession.rootNode).includes(task.paneId)
    ) {
      isAlreadyVisible = true;
    }
  }
}
```

## Files to touch
- `src/store/task-store.ts` — replace the visibility check loop with active-workspace-scoped check
