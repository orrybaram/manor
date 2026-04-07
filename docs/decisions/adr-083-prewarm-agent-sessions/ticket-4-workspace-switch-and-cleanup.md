---
title: Handle workspace switches and app lifecycle
status: todo
priority: medium
assignee: sonnet
blocked_by: [2]
---

# Handle workspace switches and app lifecycle

Ensure the prewarmed session stays in sync with the active workspace and is properly cleaned up.

## 1. Workspace switch — update prewarmed CWD

When the active workspace changes, the prewarmed session's CWD may be stale. The PrewarmManager needs to know about workspace changes.

In `electron/app-lifecycle.ts`, the stream event handler already processes events from the renderer. Add a new IPC handler:

```typescript
ipcMain.handle("prewarm:updateCwd", async (_event, cwd: string) => {
  await prewarmManager.updateCwd(cwd);
});
```

In the renderer, call this when the active workspace changes. In `src/App.tsx` or wherever workspace switching is handled, add:

```typescript
// When active workspace path changes:
window.electronAPI.prewarm?.updateCwd(newWorkspacePath);
```

Add to preload and electron.d.ts types.

## 2. App quit cleanup

In `electron/app-lifecycle.ts`, the `before-quit` handler should dispose the prewarmed session:

```typescript
app.on("before-quit", async () => {
  await prewarmManager.dispose();
  // ... existing cleanup
});
```

This prevents an orphaned shell process in the daemon after the app closes.

## 3. Daemon reconnect

If the daemon connection drops and reconnects (e.g. daemon crashed and was re-spawned), the prewarmed session is lost. The PrewarmManager should handle this gracefully.

In `PrewarmManager`, add a `reset()` method:
```typescript
reset(): void {
  this.prewarmPaneId = null;
  this.state = "idle";
}
```

In `app-lifecycle.ts`, if the daemon reconnects (after a disconnect), call:
```typescript
prewarmManager.reset();
prewarmManager.warm().catch(() => {});
```

## 4. Initial warm after daemon connects

The PrewarmManager should start warming once the daemon is confirmed connected. In `app-lifecycle.ts`, after the first successful IPC call or explicit `backend.pty.ensureConnected()`:

```typescript
backend.pty.ensureConnected().then(() => {
  const cwd = /* get initial workspace path */ process.env.HOME || "/";
  prewarmManager.warm(cwd).catch(() => {});
});
```

If the active workspace is known at startup (from layout persistence), use that CWD instead.

## Files to touch
- `electron/app-lifecycle.ts` — Workspace change IPC, before-quit disposal, reconnect handling, initial warm
- `electron/prewarm-manager.ts` — Add `reset()` method
- `electron/preload.ts` — Expose `prewarm.updateCwd` in electronAPI
- `src/electron.d.ts` — Add prewarm types
- `src/App.tsx` — Call `prewarm.updateCwd` on workspace switch
