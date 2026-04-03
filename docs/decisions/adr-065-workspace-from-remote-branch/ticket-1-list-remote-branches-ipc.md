---
title: Add listRemoteBranches IPC endpoint
status: todo
priority: high
assignee: sonnet
blocked_by: []
---

# Add listRemoteBranches IPC endpoint

Add a new IPC handler that lists branches available on origin for a given project.

## Implementation

In `electron/persistence.ts`, add a method to `ProjectManager`:

```typescript
async listRemoteBranches(projectId: string): Promise<string[]>
```

- Find the project by ID, get its `path`
- Run `git ls-remote --heads origin` with a 15s timeout
- Parse output: each line is `<sha>\trefs/heads/<branch>` — extract `<branch>`
- Get current worktree branches from `project.workspaces` to optionally filter them out (or leave them — the user may want to see all remote branches)
- Sort alphabetically and return

In `electron/main.ts`, register the IPC handler:

```typescript
ipcMain.handle("projects:listRemoteBranches", (_e, projectId: string) =>
  projectManager.listRemoteBranches(projectId)
);
```

In `electron/preload.ts`, expose through the bridge:

```typescript
listRemoteBranches: (projectId: string) =>
  ipcRenderer.invoke("projects:listRemoteBranches", projectId),
```

In `src/electron.d.ts`, add to the `projects` interface:

```typescript
listRemoteBranches: (projectId: string) => Promise<string[]>;
```

## Files to touch
- `electron/persistence.ts` — add `listRemoteBranches` method
- `electron/main.ts` — register IPC handler
- `electron/preload.ts` — add preload bridge
- `src/electron.d.ts` — add type definition
