---
title: Add convertMainToWorktree backend API
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Add convertMainToWorktree backend API

Add the electron backend method, IPC handler, and preload exposure for converting the main workspace's current branch into a worktree.

## Implementation

### `electron/persistence.ts` — Add `convertMainToWorktree` method

Add a new method to the `ProjectManager` class (after `createWorktree`):

```typescript
async convertMainToWorktree(
  projectId: string,
  name: string,
): Promise<ProjectInfo | null>
```

Logic:
1. Find the project, bail if not found
2. Get the current branch of the main workspace via `git rev-parse --abbrev-ref HEAD` in `project.path`
3. If branch equals `project.defaultBranch`, throw an error — nothing to convert
4. Compute worktree path same way as `createWorktree`: use `project.worktreePath` or fallback to `~/.manor/worktrees/<project-slug>/<name-slug>`
5. Run `git worktree prune` (same as createWorktree does)
6. Run `git worktree add <worktreePath> <currentBranch>` — this creates a worktree checking out the existing branch
7. Run `git checkout <project.defaultBranch>` in `project.path` to reset main back to default branch
8. If name differs from branch, store custom name in `project.workspaceNames`
9. `this.saveState()` and return `this.buildProjectInfo(project)`

If step 7 fails (e.g. uncommitted changes), we need to clean up: remove the worktree we just created (`git worktree remove --force <path>`) and re-throw the error so the frontend can show it.

### `electron/main.ts` — Add IPC handler

Add near the other project IPC handlers:

```typescript
ipcMain.handle(
  "projects:convertMainToWorktree",
  (_event, projectId: string, name: string) => {
    return projectManager.convertMainToWorktree(projectId, name);
  },
);
```

### `electron/preload.ts` — Expose in contextBridge

Add to the `projects` object in the preload script:

```typescript
convertMainToWorktree: (projectId: string, name: string) =>
  ipcRenderer.invoke("projects:convertMainToWorktree", projectId, name),
```

### `src/electron.d.ts` — Add type declaration

Add to the `projects` interface:

```typescript
convertMainToWorktree: (
  projectId: string,
  name: string,
) => Promise<import("./store/project-store").ProjectInfo | null>;
```

## Files to touch
- `electron/persistence.ts` — Add `convertMainToWorktree` method to ProjectManager class
- `electron/main.ts` — Add IPC handler for `projects:convertMainToWorktree`
- `electron/preload.ts` — Expose new IPC call in contextBridge
- `src/electron.d.ts` — Add type for the new API method
