---
title: Add git IPC handlers for stage/unstage/discard/stash
status: done
priority: critical
assignee: sonnet
blocked_by: []
---

# Add git IPC handlers for stage/unstage/discard/stash

Add a new `git` namespace to the electron API with four operations that accept a workspace path and array of file paths.

## Implementation

### `electron/main.ts` — Add IPC handlers after the diffs section (~line 757)

```typescript
// ── Git Operations IPC ──
ipcMain.handle("git:stage", async (_event, wsPath: string, files: string[]) => {
  assertString(wsPath, "wsPath");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  await execFileAsync("git", ["add", "--", ...files], { cwd: wsPath, timeout: 10000 });
});

ipcMain.handle("git:unstage", async (_event, wsPath: string, files: string[]) => {
  assertString(wsPath, "wsPath");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  await execFileAsync("git", ["restore", "--staged", "--", ...files], { cwd: wsPath, timeout: 10000 });
});

ipcMain.handle("git:discard", async (_event, wsPath: string, files: string[]) => {
  assertString(wsPath, "wsPath");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  // For tracked files: restore from HEAD
  try {
    await execFileAsync("git", ["checkout", "HEAD", "--", ...files], { cwd: wsPath, timeout: 10000 });
  } catch { /* some files may be untracked */ }
  // For untracked files: remove them
  try {
    await execFileAsync("git", ["clean", "-f", "--", ...files], { cwd: wsPath, timeout: 10000 });
  } catch { /* some files may not be untracked */ }
});

ipcMain.handle("git:stash", async (_event, wsPath: string, files: string[]) => {
  assertString(wsPath, "wsPath");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  await execFileAsync("git", ["stash", "push", "--", ...files], { cwd: wsPath, timeout: 10000 });
});
```

### `electron/preload.ts` — Add `git` to the contextBridge (~after diffs section, line 154)

```typescript
git: {
  stage: (wsPath: string, files: string[]) =>
    ipcRenderer.invoke("git:stage", wsPath, files),
  unstage: (wsPath: string, files: string[]) =>
    ipcRenderer.invoke("git:unstage", wsPath, files),
  discard: (wsPath: string, files: string[]) =>
    ipcRenderer.invoke("git:discard", wsPath, files),
  stash: (wsPath: string, files: string[]) =>
    ipcRenderer.invoke("git:stash", wsPath, files),
},
```

### `src/electron.d.ts` — Add type definition (~after diffs section, line 290)

```typescript
git: {
  stage: (wsPath: string, files: string[]) => Promise<void>;
  unstage: (wsPath: string, files: string[]) => Promise<void>;
  discard: (wsPath: string, files: string[]) => Promise<void>;
  stash: (wsPath: string, files: string[]) => Promise<void>;
};
```

## Files to touch
- `electron/main.ts` — add 4 ipcMain.handle() handlers after diffs section
- `electron/preload.ts` — add `git` namespace to contextBridge after diffs
- `src/electron.d.ts` — add `git` type definitions after diffs section
