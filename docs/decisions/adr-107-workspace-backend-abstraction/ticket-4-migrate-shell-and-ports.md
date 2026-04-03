---
title: Implement LocalShellBackend and LocalPortsBackend
status: todo
priority: medium
assignee: sonnet
blocked_by: [1]
---

# Implement LocalShellBackend and LocalPortsBackend

Fill in the shell and ports sub-backends, then wire up IPC handlers.

## Implementation

### 1. Implement `electron/backend/local-shell.ts`

Wraps the existing agent discovery and command execution:

```typescript
export class LocalShellBackend implements ShellBackend {
  async which(binary: string): Promise<string | null> {
    // Use execFile("which", [binary]) — extract from main.ts shell:discoverAgents handler
    // Return path or null if not found
  }

  async exec(cmd: string, args: string[], opts: { cwd?: string; timeout?: number }): Promise<{ stdout: string; stderr: string }> {
    // Generic execFile wrapper
  }
}
```

Look at `main.ts` for the `shell:discoverAgents` handler (around line 1039-1061) — it runs `which` for agent binaries. Extract that logic.

### 2. Implement `electron/backend/local-ports.ts`

Wraps the existing `PortScanner` from `electron/ports.ts`:

```typescript
export class LocalPortsBackend implements PortsBackend {
  async scan(uid: number): Promise<ActivePort[]> {
    // Extract the core lsof scan logic from PortScanner.scan()
    // Don't include the polling/interval logic — that stays in the caller
  }

  async kill(pid: number): Promise<void> {
    process.kill(pid, "SIGTERM")
  }
}
```

**Important:** The current `PortScanner` class couples scanning with BrowserWindow event pushing (it calls `window.webContents.send("ports-changed", ...)`). The backend should only do the scan — the polling loop and event forwarding stay in `main.ts`.

### 3. Update shell IPC handlers in `main.ts`

Update `shell:discoverAgents` to use `backend.shell.which()`.

### 4. Update ports IPC handlers in `main.ts`

Update `ports:scanNow` to use `backend.ports.scan()` and `ports:killPort` to use `backend.ports.kill()`.

The `PortScanner` class can remain for its polling logic, but its internal `scan()` should delegate to the backend.

### 5. Update `branch-watcher.ts`

`BranchWatcher` reads `.git/HEAD` directly via `fs.readFileSync`. Update it to accept a `ShellBackend` or just use `backend.git.exec()` to read the current branch. Alternatively, since reading `.git/HEAD` is a filesystem operation that's tightly coupled to git internals, it can stay as-is for now with a TODO comment for the remote backend.

## Files to touch
- `electron/backend/local-shell.ts` — Fill in implementation
- `electron/backend/local-ports.ts` — Fill in implementation
- `electron/main.ts` — Update shell and ports IPC handlers
- `electron/ports.ts` — Decouple scan logic from BrowserWindow event push
- `electron/branch-watcher.ts` — Add TODO comment for remote backend consideration
