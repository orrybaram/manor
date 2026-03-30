---
title: Add killPort IPC handler and preload bridge
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Add killPort IPC handler and preload bridge

Wire up the backend plumbing to kill a process by PID and expose it to the renderer.

## Implementation

### 1. IPC handler in `electron/main.ts`

Add after the existing port scanner IPC handlers (~line 549):

```typescript
ipcMain.handle("ports:killPort", async (_event, pid: number) => {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Process may have already exited — ignore
  }
  // Re-scan immediately so UI updates
  const ports = await portScanner.scanNow();
  const enriched = enrichPorts(ports);
  mainWindow?.webContents.send("ports-changed", enriched);
});
```

### 2. Preload bridge in `electron/preload.ts`

Add `killPort` to the `ports` object (~line 118, before `scanNow`):

```typescript
killPort: (pid: number) => ipcRenderer.invoke("ports:killPort", pid),
```

### 3. Type definition in `src/electron.d.ts`

Add to the `ports` section of `ElectronAPI` (~line 244, before `scanNow`):

```typescript
killPort: (pid: number) => Promise<void>;
```

## Files to touch
- `electron/main.ts` — add `ports:killPort` IPC handler
- `electron/preload.ts` — expose `killPort` in ports bridge
- `src/electron.d.ts` — add type for `killPort`
