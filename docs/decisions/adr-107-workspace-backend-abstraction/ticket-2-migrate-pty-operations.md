---
title: Implement LocalPtyBackend and wire PTY IPC handlers
status: in-progress
priority: critical
assignee: opus
blocked_by: [1]
---

# Implement LocalPtyBackend and wire PTY IPC handlers

Fill in `LocalPtyBackend` by wrapping the existing `TerminalHostClient`, then update `main.ts` PTY IPC handlers to use the backend.

## Implementation

### 1. Implement `electron/backend/local-pty.ts`

`LocalPtyBackend` wraps `TerminalHostClient`. Every method delegates directly:

```typescript
export class LocalPtyBackend implements PtyBackend {
  constructor(private client: TerminalHostClient) {}

  async createOrAttach(sessionId: string, cwd: string, cols: number, rows: number) {
    return this.client.createOrAttach(sessionId, cwd, cols, rows)
  }
  write(sessionId: string, data: string) { this.client.writeNoAck(sessionId, data) }
  async resize(sessionId: string, cols: number, rows: number) { await this.client.resize(sessionId, cols, rows) }
  async kill(sessionId: string) { await this.client.kill(sessionId) }
  async detach(sessionId: string) { await this.client.detach(sessionId) }
  async getSnapshot(sessionId: string) { return this.client.getSnapshot(sessionId) }
  async listSessions() { return this.client.listSessions() }
  onEvent(handler: (event: StreamEvent) => void) { this.client.onEvent(handler) }
  async updateEnv(env: Record<string, string>) { await this.client.updateEnv(env) }
}
```

Check `TerminalHostClient`'s actual public method signatures carefully and match them exactly.

### 2. Update PTY IPC handlers in `electron/main.ts`

Currently (lines 347-419), handlers call `client.createOrAttach(...)`, `client.writeNoAck(...)`, etc. directly on the `TerminalHostClient` instance.

Change these to go through the backend:

```typescript
// Before:
const result = await client.createOrAttach(paneId, cwd || process.env.HOME || "/", cols, rows)

// After:
const result = await backend.pty.createOrAttach(paneId, cwd || process.env.HOME || "/", cols, rows)
```

Do the same for: `pty:write`, `pty:resize`, `pty:close`, `pty:detach`.

### 3. Update layout:getRestoredSessions handler

Line 434-447 calls `client.listSessions()` — change to `backend.pty.listSessions()`.

### 4. Update stream event forwarding

The stream event handler (search for `client.onEvent` in main.ts) forwards PTY events to the renderer via `webContents.send`. Change `client.onEvent(...)` to `backend.pty.onEvent(...)`.

### 5. Update `updateEnv` call

Search for `client.updateEnv` in main.ts — change to `backend.pty.updateEnv(...)`.

### 6. Instantiate the backend

Near the top of `main.ts` where `client = new TerminalHostClient()` is created, also create:
```typescript
const backend = new LocalBackend(client)
```

Import `LocalBackend` from `./backend/local-backend`.

**Important:** Do NOT remove the `client` variable yet — other parts of main.ts may still reference it directly (e.g., `ScrollbackWriter`, `LayoutPersistence`). Only replace the IPC handler usages. The `client` variable can be fully removed once all tickets are done.

## Files to touch
- `electron/backend/local-pty.ts` — Fill in implementation wrapping TerminalHostClient
- `electron/main.ts` — Update PTY IPC handlers + stream event handler + instantiate LocalBackend
