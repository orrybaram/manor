---
title: Auto-link issues on workspace and task creation
status: done
priority: high
assignee: sonnet
blocked_by: [1]
---

# Auto-link issues on workspace and task creation

Wire the two existing Linear flows to call `linkIssueToWorkspace` so tickets are automatically linked when workspaces or tasks are created from Linear issues.

## Implementation

### 1. Link on workspace creation from Linear issue

In `src/components/CommandPalette/IssueDetailView.tsx`, `handleCreateWorkspace` (line ~45):

**When creating a new workspace:**
After calling `onNewWorkspace()`, the workspace doesn't exist yet (it's created asynchronously). The linking needs to happen after the workspace is confirmed created. Two approaches:

- **Option A (preferred):** Have `onNewWorkspace` return or resolve with the workspace path. Then call `window.electronAPI.linear.linkIssueToWorkspace(projectId, workspacePath, { id: issue.id, identifier: issue.identifier, title: issue.title, url: issue.url })`.
- **Option B:** Link in the persistence layer itself — pass the issue data through to `createWorktree()` and link there. This is more reliable since persistence knows the exact workspace path.

Go with **Option B**: extend `createWorktree()` in `persistence.ts` to accept an optional `linkedIssue?: LinkedIssue` parameter. When provided, automatically call `linkIssueToWorkspace` after successful worktree creation.

Then in the renderer, pass the issue data through `onNewWorkspace`:
- Update the `NewWorkspaceRequest` type (or equivalent) to include an optional `linkedIssue` field.
- `IssueDetailView.handleCreateWorkspace` already builds the `onNewWorkspace` payload — add the issue data there.

**When switching to an existing workspace (branch already exists):**
In the same `handleCreateWorkspace`, when `existingIdx >= 0`, also link the issue to the existing workspace. The workspace path is available from `current.workspaces[existingIdx].path`.

### 2. Link on task creation from Linear issue

In `src/components/CommandPalette/IssueDetailView.tsx`, `handleNewTask` (line ~91):

The task is created in the currently active workspace. After `onNewTaskWithPrompt()`:

```typescript
const activeWorkspacePath = useAppStore.getState().activeWorkspacePath;
const projects = useProjectStore.getState().projects;
const project = projects.find((p) =>
  p.workspaces.some((w) => w.path === activeWorkspacePath)
);
if (project && activeWorkspacePath) {
  window.electronAPI.linear.linkIssueToWorkspace(
    project.id,
    activeWorkspacePath,
    { id: issue.id, identifier: issue.identifier, title: issue.title, url: issue.url }
  );
}
```

This links the Linear issue to whatever workspace is currently active when the task is created.

### 3. Deduplicate

The persistence layer (ticket 1) deduplicates by issue ID, so linking the same issue twice is a no-op. No guard needed in the renderer.

## Files to touch
- `src/components/CommandPalette/IssueDetailView.tsx` — add linking calls in `handleCreateWorkspace` and `handleNewTask`
- `electron/persistence.ts` — extend `createWorktree()` to accept optional `linkedIssue` and auto-link
- `src/store/project-store.ts` — update `NewWorkspaceRequest` type if needed to carry `linkedIssue`
