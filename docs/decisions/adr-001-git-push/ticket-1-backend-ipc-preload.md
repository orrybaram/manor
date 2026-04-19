---
title: Add git push — backend, IPC, and preload
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Add git push — backend, IPC, and preload

Implement the backend `push` method, register the IPC handler, and expose it in the preload.

## Files to touch

- `electron/backend/types.ts` — add `push(cwd: string, remote?: string, branch?: string): Promise<void>` to `GitBackend` interface
- `electron/backend/local-git.ts` — implement `push` in `LocalGitBackend`:
  - If no `branch` provided, resolve it with `git rev-parse --abbrev-ref HEAD`
  - Run `git push <remote|origin> <branch>` with `timeout: 60000`
  - On failure, throw `new Error(stderr.trim() || "Push failed")`
- `electron/ipc/branches-diffs.ts` — add handler:
  ```ts
  ipcMain.handle("git:push", async (_event, wsPath: string, remote?: string, branch?: string) => {
    assertString(wsPath, "wsPath");
    await backend.git.push(wsPath, remote, branch);
  });
  ```
- `electron/preload.ts` — add to `git` object inside `contextBridge.exposeInMainWorld`:
  ```ts
  push: (wsPath: string, remote?: string, branch?: string) =>
    ipcRenderer.invoke("git:push", wsPath, remote, branch),
  ```
