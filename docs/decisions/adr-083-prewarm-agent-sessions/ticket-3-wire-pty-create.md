---
title: Wire renderer to use prewarmed sessions
status: in-progress
priority: high
assignee: sonnet
blocked_by: [1, 2]
---

# Wire renderer to use prewarmed sessions

Connect the PrewarmManager to the renderer's new-task flow so prewarmed sessions are consumed transparently.

## 1. Allow createTab to accept a paneId

In `src/store/app-store.ts`, modify `createTab()` to accept an optional paneId:

```typescript
function createTab(title?: string, paneId?: string): Tab {
  const id = paneId ?? newPaneId();
  return {
    id: newTabId(),
    title: title ?? "Terminal",
    rootNode: { type: "leaf", paneId: id },
    focusedPaneId: id,
  };
}
```

Update `addTab` action to pass through the paneId:
```typescript
addTab: (paneId?: string) => {
  // ... existing context logic
  const tab = createTab(undefined, paneId);
  // ... rest unchanged
}
```

Similarly update `addTabWithCommand` to accept an optional paneId.

## 2. Consume prewarmed session in handleNewTask

In `src/App.tsx`, modify `handleNewTask()`:

```typescript
const handleNewTask = useCallback(async () => {
  const path = useAppStore.getState().activeWorkspacePath;
  if (!path) return;

  const projects = useProjectStore.getState().projects;
  const project = projects.find((p) =>
    p.workspaces.some((ws) => ws.path === path),
  );
  const cmd = project?.agentCommand || defaultAgentCommand;
  useAppStore.getState().setPendingStartupCommand(path, cmd);

  // Try to use a prewarmed session for instant startup
  const prewarmPaneId = await window.electronAPI.pty.consumePrewarmed();
  useAppStore.getState().addTab(prewarmPaneId ?? undefined);
}, [defaultAgentCommand]);
```

Note: `handleNewTask` becomes async but `addTab` is still synchronous.

## 3. Return prewarmed flag from pty:create

In `electron/ipc/pty.ts`, modify the `pty:create` handler to detect when the session was prewarmed. The warm-restore path in `createOrAttach` finds the existing session via `getSnapshot`. To distinguish prewarmed from regular warm-restore:

Check if the session was prewarmed before `createOrAttach` consumes it:

```typescript
ipcMain.handle("pty:create", async (_event, paneId, cwd, cols, rows) => {
  // ... existing validation ...
  try {
    // Check if this is a prewarmed session (snapshot exists = warm restore)
    const snapshot = await backend.pty.getSnapshot(paneId);
    const isPrewarmed = snapshot !== null;

    const result = await backend.pty.createOrAttach(paneId, cwd || process.env.HOME || "/", cols, rows);
    return {
      ok: true,
      snapshot: result.snapshot?.screenAnsi || null,
      prewarmed: isPrewarmed,
    };
  } catch (err) {
    // ... existing error handling ...
  }
});
```

## 4. Handle prewarmed flag in useTerminalLifecycle

In `src/hooks/useTerminalLifecycle.ts`, update the `create()` callback response handling:

```typescript
create(cwd ?? null, cols, rows).then(
  (result: { ok: boolean; snapshot?: string | null; error?: string; prewarmed?: boolean }) => {
    if (!disposed && !result.ok) {
      setPtyError(result.error ?? "Failed to create terminal session");
      return;
    }
    if (!disposed && result.ok) {
      if (result.snapshot) {
        t.write(result.snapshot);
      }

      // ... existing pane context logic ...

      const store = useAppStore.getState();
      const wsPath = store.activeWorkspacePath;
      const paneCmd = store.consumePendingPaneCommand(paneId);
      const startupCmd =
        !paneCmd && wsPath && cwd === wsPath
          ? store.consumePendingStartupCommand(wsPath)
          : null;
      const pendingCmd = paneCmd || startupCmd;

      if (pendingCmd) {
        if (result.prewarmed) {
          // Shell is already initialized — write command immediately
          write(pendingCmd + "\n");
        } else {
          // Cold start — wait for first prompt
          const unsubReady = window.electronAPI.pty.onOutput(paneId, () => {
            unsubReady();
            if (!disposed) write(pendingCmd + "\n");
          });
        }
      }
    }
  },
);
```

## 5. Update types

In `src/electron.d.ts`, update the `pty.create` return type to include `prewarmed`:
```typescript
create: (paneId: string, cwd: string | null, cols: number, rows: number) =>
  Promise<{ ok: boolean; snapshot?: string | null; error?: string; prewarmed?: boolean }>;
```

## Files to touch
- `src/store/app-store.ts` — `createTab()` and `addTab` accept optional paneId
- `src/App.tsx` — `handleNewTask()` consumes prewarmed paneId
- `electron/ipc/pty.ts` — `pty:create` returns `prewarmed` flag
- `src/hooks/useTerminalLifecycle.ts` — Skip prompt wait when `prewarmed` is true
- `src/electron.d.ts` — Update return type
