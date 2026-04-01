---
title: Add progress events to createWorktree backend
status: done
priority: critical
assignee: sonnet
blocked_by: []
---

# Add progress events to createWorktree backend

Emit progress events from the `createWorktree` method in `electron/persistence.ts` so the renderer can show real-time setup status.

## Implementation

### 1. Add progress event emitter to ProjectManager

In `electron/persistence.ts`, the `ProjectManager` class needs access to `BrowserWindow` to send events. Add a method to emit setup progress:

```typescript
private emitSetupProgress(step: string, status: string, message?: string) {
  const wins = BrowserWindow.getAllWindows();
  for (const win of wins) {
    win.webContents.send("worktree:setup-progress", { step, status, message });
  }
}
```

Import `BrowserWindow` from `electron` at the top of the file.

### 2. Add progress emissions to createWorktree

In the `createWorktree` method (lines 702-827), emit events at each stage:

- Before `git worktree prune` (line 720): emit `{ step: "prune", status: "in-progress" }`
- After prune completes (line 730): emit `{ step: "prune", status: "done" }`
- Before fetch (line 733): emit `{ step: "fetch", status: "in-progress" }`  
- After fetch completes (line 758): emit `{ step: "fetch", status: "done" }`
- Before worktree add attempts (line 762): emit `{ step: "create-worktree", status: "in-progress" }` with message describing branch strategy
- After worktree created (line 807): emit `{ step: "create-worktree", status: "done" }`
- Before saving state (line 810): emit `{ step: "persist", status: "in-progress" }`
- After saveState (line 824): emit `{ step: "persist", status: "done" }`

### 3. Add preload listener

In `electron/preload.ts`, expose a listener for the progress channel:

```typescript
onWorktreeSetupProgress: (callback: (event: any) => void) => {
  const handler = (_event: any, data: any) => callback(data);
  ipcRenderer.on("worktree:setup-progress", handler);
  return () => ipcRenderer.removeListener("worktree:setup-progress", handler);
},
```

Add this under the `projects` namespace in the preload API.

### 4. Update TypeScript types

Add the `SetupStep`, `StepStatus`, and `SetupProgressEvent` types in the appropriate shared types location (near the `ProjectInfo` types in `project-store.ts` or a new `types/setup.ts`).

## Files to touch
- `electron/persistence.ts` — add `emitSetupProgress` method, emit events in `createWorktree`
- `electron/preload.ts` — add `onWorktreeSetupProgress` listener in projects namespace
