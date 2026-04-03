---
title: Create PrewarmManager in Electron main
status: done
priority: high
assignee: sonnet
blocked_by: [1]
---

# Create PrewarmManager in Electron main

New class that manages the lifecycle of a single prewarmed daemon session.

## Implementation

Create `electron/prewarm-manager.ts`:

```typescript
class PrewarmManager {
  private prewarmSessionId: string | null = null;
  private state: "idle" | "warming" | "ready" = "idle";
  private client: TerminalHostClient;
  private currentCwd: string;

  constructor(client: TerminalHostClient, defaultCwd: string) { ... }

  /** Start warming a session for the given CWD */
  async warm(cwd: string): Promise<void> { ... }

  /** Try to consume the prewarmed session. Returns null if unavailable. */
  async consume(newSessionId: string, cwd: string, cols: number, rows: number): Promise<{ session: SessionInfo; snapshot: TerminalSnapshot | null } | null> { ... }

  /** Kill the current prewarmed session (workspace changed, app quitting) */
  async dispose(): Promise<void> { ... }

  /** Update the target CWD (e.g., on workspace switch) */
  async updateCwd(cwd: string): Promise<void> { ... }
}
```

### Behavior
- `warm()`: Generates a temporary session ID (e.g., `prewarm-{uuid}`), calls `client.prewarm()`, sets state to `ready`
- `consume()`: If state is `ready`, calls `client.claimPrewarmed()` to rename session to `newSessionId`, subscribes to stream, immediately calls `warm()` to prepare the next one. If state is not `ready`, returns `null`.
- `updateCwd()`: If the CWD changes (workspace switch), kill the stale prewarmed session and warm a new one for the new CWD
- `dispose()`: Kill the prewarmed session if it exists

### Integration
- Instantiate in `main.ts` after daemon client connects
- Call `warm()` with the initial workspace path
- Listen for workspace-change events to call `updateCwd()`
- Call `dispose()` on app quit (in the `before-quit` handler)

## Files to touch
- `electron/prewarm-manager.ts` — New file, the PrewarmManager class
- `electron/main.ts` — Instantiate PrewarmManager after daemon connect, dispose on quit, listen for workspace changes
