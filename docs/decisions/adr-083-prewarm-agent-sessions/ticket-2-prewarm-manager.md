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
import { TerminalHostClient } from "./terminal-host/client";
import crypto from "node:crypto";

type PrewarmState = "idle" | "warming" | "ready";

export class PrewarmManager {
  private client: TerminalHostClient;
  private state: PrewarmState = "idle";
  private prewarmPaneId: string | null = null;
  private currentCwd: string;
  private defaultCols = 80;
  private defaultRows = 24;

  constructor(client: TerminalHostClient, defaultCwd: string) {
    this.client = client;
    this.currentCwd = defaultCwd;
  }

  /** Start warming a session in the background */
  async warm(cwd?: string): Promise<void> {
    if (cwd) this.currentCwd = cwd;
    if (this.state === "warming") return;

    this.state = "warming";
    const paneId = `pane-${crypto.randomUUID()}`;

    try {
      await this.client.createNoSubscribe(
        paneId,
        this.currentCwd,
        this.defaultCols,
        this.defaultRows,
        true, // prewarmed flag
      );
      this.prewarmPaneId = paneId;
      this.state = "ready";
    } catch (err) {
      console.error("[PrewarmManager] Failed to warm session:", err);
      this.state = "idle";
      this.prewarmPaneId = null;
    }
  }

  /**
   * Consume the prewarmed session.
   * Returns the pre-generated paneId, or null if no session is ready.
   */
  consume(): string | null {
    if (this.state !== "ready" || !this.prewarmPaneId) {
      return null;
    }

    const paneId = this.prewarmPaneId;
    this.prewarmPaneId = null;
    this.state = "idle";

    // Replenish in the background
    this.warm().catch(() => {});

    return paneId;
  }

  /** Update CWD (e.g. on workspace switch) — kill stale, warm fresh */
  async updateCwd(cwd: string): Promise<void> {
    if (cwd === this.currentCwd && this.state === "ready") return;
    await this.dispose();
    await this.warm(cwd);
  }

  /** Kill the prewarmed session */
  async dispose(): Promise<void> {
    if (this.prewarmPaneId) {
      try {
        await this.client.kill(this.prewarmPaneId);
      } catch {
        // ignore — daemon may have restarted
      }
    }
    this.prewarmPaneId = null;
    this.state = "idle";
  }

  /** Check if a prewarmed session is available */
  get isReady(): boolean {
    return this.state === "ready" && this.prewarmPaneId !== null;
  }
}
```

## Integration in app-lifecycle.ts

In `electron/app-lifecycle.ts`:

1. Import and instantiate after the client:
   ```typescript
   import { PrewarmManager } from "./prewarm-manager";
   // ... after client is created:
   const prewarmManager = new PrewarmManager(client, process.env.HOME || "/");
   ```

2. After the daemon connects (after backend.pty.ensureConnected() or first IPC call succeeds), start warming:
   ```typescript
   // In the app.whenReady() flow, after ensuring daemon is connected:
   prewarmManager.warm().catch(() => {});
   ```

3. Pass `prewarmManager` to the IPC deps so `pty:create` can access it.

4. On `before-quit`, dispose:
   ```typescript
   app.on("before-quit", async () => {
     await prewarmManager.dispose();
   });
   ```

## IPC for renderer access

Register a new IPC handler so the renderer can get the prewarmed paneId:

```typescript
ipcMain.handle("pty:consumePrewarmed", () => {
  return prewarmManager.consume();
});
```

Add to the preload/electronAPI type:
```typescript
pty: {
  // ... existing methods
  consumePrewarmed: () => Promise<string | null>;
}
```

## Files to touch
- `electron/prewarm-manager.ts` — New file
- `electron/app-lifecycle.ts` — Instantiate PrewarmManager, dispose on quit, pass to deps
- `electron/ipc/pty.ts` — Add `pty:consumePrewarmed` handler
- `electron/ipc/types.ts` — Add prewarmManager to IpcDeps
- `electron/preload.ts` — Expose `consumePrewarmed` in electronAPI
- `src/electron.d.ts` — Update pty type with `consumePrewarmed`
