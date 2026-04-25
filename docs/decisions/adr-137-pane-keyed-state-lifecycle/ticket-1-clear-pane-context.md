---
title: Clear paneContextMap entries on pane close
status: todo
priority: high
assignee: sonnet
blocked_by: []
---

# Clear paneContextMap entries on pane close

`paneContextMap` (`electron/app-lifecycle.ts:77-80`) gains an entry for every pane via `tasks:setPaneContext` (`ipc/tasks.ts:62-75`) but is never trimmed. Memory leak across long uptimes; latent stale-context risk if a paneId is ever reused.

See ADR-137 §"Change 1" for full reasoning.

## What to change

Add an explicit cleanup IPC and defensive cleanup in `pty:close`.

### Main process

```ts
// electron/ipc/tasks.ts
ipcMain.handle("tasks:clearPaneContext", (_event, paneId: string) => {
  assertString(paneId, "paneId");
  paneContextMap.delete(paneId);
});
```

```ts
// electron/ipc/pty.ts (inside the pty:close handler)
ipcMain.handle("pty:close", async (_event, paneId: string) => {
  // ... existing logic ...
  // Defensive cleanup so a missed renderer call still frees the entry.
  paneContextMap.delete(paneId);
});
```

`paneContextMap` is currently a closure-scope variable in `app-lifecycle.ts`. It's already passed into `ipcDeps` (line 196), so both handlers have access — no plumbing changes.

### Renderer

Wherever `closePaneById` lives (likely `src/store/app-store.ts:~1483`, which already calls `tasks.abandonForPane`), add a parallel call to the new IPC:

```ts
window.electronAPI.tasks.clearPaneContext(paneId).catch(console.error);
window.electronAPI.tasks.abandonForPane(paneId, currentTitle).catch(console.error);
```

### Preload + types

```ts
// electron/preload.ts (in the tasks namespace)
clearPaneContext: (paneId: string) => ipcRenderer.invoke("tasks:clearPaneContext", paneId),

// src/electron.d.ts
clearPaneContext: (paneId: string) => Promise<void>;
```

## Files to touch

- `electron/ipc/tasks.ts` — new handler.
- `electron/ipc/pty.ts` — defensive delete in `pty:close`.
- `electron/preload.ts` — expose the IPC.
- `src/electron.d.ts` — type the IPC.
- `src/store/app-store.ts` (or wherever `closePaneById` lives) — invoke from the close path.

## Tests

- IPC unit: `tasks:clearPaneContext` deletes the entry; calling for a non-existent paneId is a no-op.
- IPC unit: `pty:close` deletes the entry too (regression so a missing renderer call doesn't leak).
- Renderer (component test): calling `closePaneById` invokes both `clearPaneContext` and `abandonForPane`.
