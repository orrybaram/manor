---
title: Add LinkedIssue type and persistence layer
status: done
priority: critical
assignee: sonnet
blocked_by: []
---

# Add LinkedIssue type and persistence layer

Add the `LinkedIssue` type, persistence in `projects.json`, IPC handlers, and hydration into `WorkspaceInfo`.

## Implementation

### 1. Add `LinkedIssue` type to `electron/linear.ts`

Add after the existing type definitions (around line 38):

```typescript
export interface LinkedIssue {
  id: string;
  identifier: string;
  title: string;
  url: string;
}
```

### 2. Update `PersistedProject` in `electron/persistence.ts`

Add to the `PersistedProject` interface (around line 94):

```typescript
workspaceIssues?: Record<string, LinkedIssue[]>;
```

Import `LinkedIssue` from `./linear`.

### 3. Update `WorkspaceInfo` in both locations

In `electron/persistence.ts` (line ~40) and `src/store/project-store.ts` (line ~94), add:

```typescript
linkedIssues?: LinkedIssue[];
```

The renderer-side type needs a copy of `LinkedIssue` — add it to `src/electron.d.ts` or a shared types file accessible to both.

### 4. Hydrate in `buildProjectInfo()`

In `electron/persistence.ts` `buildProjectInfo()` (around line 290), after the `names` hydration:

```typescript
const issues = p.workspaceIssues ?? {};
const workspaces = rawWorkspaces.map((ws) => ({
  ...ws,
  name: names[ws.path] ?? null,
  linkedIssues: issues[ws.path] ?? [],
}));
```

### 5. Add persistence methods to `ProjectManager`

Add three methods following the pattern of `renameWorkspace()`:

- `linkIssueToWorkspace(projectId: string, workspacePath: string, issue: LinkedIssue)` — append to the array (deduplicate by `issue.id`).
- `unlinkIssueFromWorkspace(projectId: string, workspacePath: string, issueId: string)` — filter out by ID.
- `getWorkspaceIssues(projectId: string, workspacePath: string): LinkedIssue[]` — return from persisted state.

Each method should call `this.save()` after mutation and emit a project-changed event so the renderer updates.

### 6. Clean up on workspace removal

In `removeWorktree()` (around line 339-440), delete the workspace path key from `workspaceIssues` when cleaning up `workspaceNames`.

### 7. Register IPC handlers in `electron/main.ts`

Add handlers following the existing pattern (around line 646-716 where Linear handlers are registered):

```typescript
ipcMain.handle('linear:linkIssueToWorkspace', (_e, projectId, workspacePath, issue) =>
  projectManager.linkIssueToWorkspace(projectId, workspacePath, issue));
ipcMain.handle('linear:unlinkIssueFromWorkspace', (_e, projectId, workspacePath, issueId) =>
  projectManager.unlinkIssueFromWorkspace(projectId, workspacePath, issueId));
```

### 8. Expose in preload/electron.d.ts

Add to the `linear` namespace in `src/electron.d.ts` and the preload script:

```typescript
linkIssueToWorkspace(projectId: string, workspacePath: string, issue: LinkedIssue): Promise<void>;
unlinkIssueFromWorkspace(projectId: string, workspacePath: string, issueId: string): Promise<void>;
```

## Files to touch
- `electron/linear.ts` — add `LinkedIssue` export
- `electron/persistence.ts` — update `PersistedProject`, `WorkspaceInfo`, `buildProjectInfo()`, add link/unlink methods, clean up in `removeWorktree()`
- `src/store/project-store.ts` — update `WorkspaceInfo` type
- `src/electron.d.ts` — add `LinkedIssue` type and IPC method signatures
- `electron/main.ts` — register IPC handlers
- `electron/preload.ts` — expose IPC methods
