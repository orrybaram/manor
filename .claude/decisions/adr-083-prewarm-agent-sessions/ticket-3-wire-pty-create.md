---
title: Wire pty:create to use PrewarmManager
status: done
priority: high
assignee: sonnet
blocked_by: [2]
---

# Wire pty:create to use PrewarmManager

Modify the `pty:create` IPC handler to try the prewarmed session first, falling back to the existing `createOrAttach` path.

## Implementation

In the `pty:create` handler in `electron/main.ts`:

```typescript
ipcMain.handle("pty:create", async (_event, paneId, cwd, cols, rows) => {
  try {
    // Try prewarmed session first
    const prewarmed = await prewarmManager.consume(paneId, cwd || process.env.HOME || "/", cols, rows);
    if (prewarmed) {
      return {
        ok: true,
        snapshot: prewarmed.snapshot?.screenAnsi || null,
      };
    }
    // Fallback to normal create
    const result = await client.createOrAttach(paneId, cwd || process.env.HOME || "/", cols, rows);
    return { ok: true, snapshot: result.snapshot?.screenAnsi || null };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});
```

### Startup command timing

When a prewarmed session is consumed, the shell is already initialized. The 500ms `setTimeout` in `useTerminalLifecycle.ts` (line 181) is unnecessary for prewarmed sessions. To handle this:

- Add a `prewarmed: boolean` field to the `pty:create` return value
- In `useTerminalLifecycle.ts`, if `result.prewarmed` is true, write the startup command immediately (no setTimeout)
- If false, keep the existing 500ms delay

## Files to touch
- `electron/main.ts` — Modify `pty:create` handler to try prewarmManager first, add `prewarmed` field to response
- `src/hooks/useTerminalLifecycle.ts` — Check `result.prewarmed` flag to skip the 500ms delay
- `src/electron.d.ts` — Update `pty.create` return type to include `prewarmed` field (if typed)
