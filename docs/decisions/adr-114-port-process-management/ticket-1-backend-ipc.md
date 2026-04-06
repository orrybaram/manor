---
title: Add processes IPC handlers and preload API
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Add processes IPC handlers and preload API

Implement the backend IPC channels for listing and killing Manor processes, and expose them through the preload bridge.

## Implementation

### 1. Create `electron/ipc/processes.ts`

Register these IPC handlers:

**`processes:list`** — Returns `ManorProcessInfo`:
- Read daemon PID from `~/.manor/daemons/{version}/terminal-host.pid` (the version comes from `app.getVersion()`)
- Check if alive via `process.kill(pid, 0)` (catches errors = not alive)
- Read internal server ports from the deps: `agentHookServer.hookPort`, `webviewServer.serverPort`, `portlessManager.proxyPort`
- Call `backend.pty.listSessions()` for session list
- Call `portScanner.scanNow()` for current ports (use the existing enrichPorts pattern from `electron/ipc/ports.ts`)

**`processes:killSession`** — Takes `sessionId: string`:
- Call `backend.pty.kill(sessionId)`

**`processes:killDaemon`** — Kills the daemon process:
- Read PID from pidfile
- `process.kill(pid, 'SIGTERM')`
- Clean up socket and pid files

**`processes:killAll`** — Nuclear option:
1. List all sessions via `backend.pty.listSessions()`
2. Kill each session via `backend.pty.kill(sessionId)`
3. Kill all workspace-associated ports via `backend.ports.kill(pid)` for each
4. Kill the daemon via SIGTERM to its PID
5. Return void (fire and forget, UI will re-query)

The `register` function should accept the same `IpcDeps` pattern used by other IPC modules. It also needs access to `agentHookServer`, `webviewServer`, and `portlessManager` — pass these as additional deps or read from the module-level singletons (follow the pattern in `electron/ipc/ports.ts`).

### 2. Register in `electron/ipc/index.ts`

Import and call `processes.register(deps)` alongside the existing modules.

### 3. Add to preload bridge (`electron/preload.ts`)

Add a `processes` namespace:
```typescript
processes: {
  list: () => ipcRenderer.invoke('processes:list'),
  killSession: (sessionId: string) => ipcRenderer.invoke('processes:killSession', sessionId),
  killDaemon: () => ipcRenderer.invoke('processes:killDaemon'),
  killAll: () => ipcRenderer.invoke('processes:killAll'),
}
```

### 4. Add TypeScript types (`src/electron.d.ts`)

Add the `ManorProcessInfo` interface and the `processes` property to `ElectronAPI`:

```typescript
export interface ManorProcessInfo {
  daemon: {
    pid: number | null;
    alive: boolean;
    version: string;
  };
  internalServers: Array<{
    name: string;
    port: number | null;
  }>;
  sessions: Array<{
    sessionId: string;
    alive: boolean;
    cwd: string | null;
  }>;
  ports: ActivePort[];
}
```

## Files to touch
- `electron/ipc/processes.ts` — new file, IPC handlers
- `electron/ipc/index.ts` — register the new module
- `electron/preload.ts` — add `processes` namespace to context bridge
- `src/electron.d.ts` — add `ManorProcessInfo` type and `processes` API to `ElectronAPI`
