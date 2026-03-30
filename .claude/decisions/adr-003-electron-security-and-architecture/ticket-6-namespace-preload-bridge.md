---
title: Namespace the preload bridge into domain groups
status: done
priority: medium
assignee: opus
blocked_by: []
---

# Namespace the preload bridge into domain groups

The preload script exposes ~40+ functions as a flat `window.electronAPI` object. Restructure into namespaced sub-objects for better maintainability and auditability.

## Implementation

### 1. Restructure preload.ts

Change `contextBridge.exposeInMainWorld("electronAPI", { ... })` to group handlers by domain:

```typescript
contextBridge.exposeInMainWorld("electronAPI", {
  pty: {
    create: (paneId, cwd, cols, rows) => ipcRenderer.invoke("pty:create", paneId, cwd, cols, rows),
    write: (paneId, data) => ipcRenderer.invoke("pty:write", paneId, data),
    resize: (paneId, cols, rows) => ipcRenderer.invoke("pty:resize", paneId, cols, rows),
    close: (paneId) => ipcRenderer.invoke("pty:close", paneId),
    detach: (paneId) => ipcRenderer.invoke("pty:detach", paneId),
    onOutput: (paneId, callback) => { /* ... */ },
    onExit: (paneId, callback) => { /* ... */ },
    onCwd: (paneId, callback) => { /* ... */ },
    onAgentStatus: (paneId, callback) => { /* ... */ },
  },
  layout: {
    save: (workspace) => ipcRenderer.invoke("layout:save", workspace),
    load: () => ipcRenderer.invoke("layout:load"),
    getRestoredSessions: () => ipcRenderer.invoke("layout:getRestoredSessions"),
  },
  projects: {
    getAll: () => ipcRenderer.invoke("projects:getAll"),
    // ... all projects handlers
  },
  theme: {
    get: () => ipcRenderer.invoke("theme:get"),
    // ... all theme handlers
  },
  ports: {
    startScanner: () => ipcRenderer.invoke("ports:startScanner"),
    // ... all ports handlers
  },
  branches: {
    start: (paths) => ipcRenderer.invoke("branches:start", paths),
    stop: () => ipcRenderer.invoke("branches:stop"),
    onChange: (callback) => { /* ... */ },
  },
  diffs: {
    start: (workspaces) => ipcRenderer.invoke("diffs:start", workspaces),
    stop: () => ipcRenderer.invoke("diffs:stop"),
    onChange: (callback) => { /* ... */ },
  },
  github: {
    getPrForBranch: (repoPath, branch) => ipcRenderer.invoke("github:getPrForBranch", repoPath, branch),
    getPrsForBranches: (repoPath, branches) => ipcRenderer.invoke("github:getPrsForBranches", repoPath, branches),
  },
  linear: {
    connect: (apiKey) => ipcRenderer.invoke("linear:connect", apiKey),
    // ... all linear handlers
  },
  dialog: {
    openDirectory: () => ipcRenderer.invoke("dialog:openDirectory"),
  },
  shell: {
    openExternal: (url) => ipcRenderer.invoke("shell:openExternal", url),
  },
});
```

### 2. Update TypeScript type declaration

Find or create the type declaration for `window.electronAPI` (likely in a `src/types/` or `src/electron.d.ts` file). Update the interface to match the new nested structure.

### 3. Update all renderer references

Search for all uses of `window.electronAPI.` in the `src/` directory and update to the new namespaced paths:

- `window.electronAPI.ptyCreate(...)` → `window.electronAPI.pty.create(...)`
- `window.electronAPI.ptyWrite(...)` → `window.electronAPI.pty.write(...)`
- `window.electronAPI.onPtyOutput(...)` → `window.electronAPI.pty.onOutput(...)`
- `window.electronAPI.saveLayout(...)` → `window.electronAPI.layout.save(...)`
- `window.electronAPI.getProjects()` → `window.electronAPI.projects.getAll()`
- `window.electronAPI.getTheme()` → `window.electronAPI.theme.get()`
- `window.electronAPI.openExternal(...)` → `window.electronAPI.shell.openExternal(...)`
- ... and so on for all ~40 handlers

Use grep to find every `window.electronAPI.` call site. There will be many — expect to touch most files in `src/components/` and `src/store/`.

### 4. Naming convention

For the namespaced methods, drop the domain prefix since the namespace already provides it:
- `ptyCreate` → `pty.create`
- `linearConnect` → `linear.connect`
- `onPtyOutput` → `pty.onOutput`
- `onBranchesChanged` → `branches.onChange`
- `startPortScanner` → `ports.startScanner`
- `getPrForBranch` → `github.getPrForBranch`

## Files to touch
- `electron/preload.ts` — restructure into namespaced groups
- `src/types/electron.d.ts` or equivalent — update type declarations
- `src/components/*.tsx` — update all `window.electronAPI.*` call sites
- `src/store/*.ts` — update all `window.electronAPI.*` call sites
- Any other `src/` files using the electron API
