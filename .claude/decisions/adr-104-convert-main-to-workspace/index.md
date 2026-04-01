---
type: adr
status: accepted
database:
  schema:
    status:
      type: select
      options: [todo, in-progress, review, done]
      default: todo
    priority:
      type: select
      options: [critical, high, medium, low]
    assignee:
      type: select
      options: [opus, sonnet, haiku]
  defaultView: board
  groupBy: status
---

# ADR-104: Convert Main Workspace Branch to Worktree

## Context

When users manually check out a feature branch in the main workspace (e.g. `git checkout feature-x` in the project root), they're left in a state where the main/local workspace is on a non-default branch. There's no way to "promote" that branch into its own worktree workspace and reset the main workspace back to the default branch.

This is a common workflow — someone starts work on the main workspace, realizes it should be a proper worktree, and wants to move it without losing their work.

## Decision

Add a "Convert to Workspace..." context menu item on the main workspace that:

1. **Only appears** when `ws.isMain && ws.branch !== project.defaultBranch`
2. **Opens a dialog** to name the new workspace (similar to NewWorkspaceDialog but simpler — the branch already exists)
3. **Backend operation** (`convertMainToWorktree`):
   - Creates a new git worktree from the current branch: `git worktree add <path> <branch>`
   - Checks out the default branch on the main workspace: `git checkout <defaultBranch>` in project.path
4. **Frontend** refreshes the project state to reflect the new worktree and updated main branch

### Files involved

**Electron backend:**
- `electron/persistence.ts` — Add `convertMainToWorktree(projectId, name)` method that creates worktree from current main branch then checks out default branch
- `electron/main.ts` — Add IPC handler `projects:convertMainToWorktree`
- `electron/preload.ts` — Expose the new IPC call

**Frontend:**
- `src/electron.d.ts` — Add type for the new API
- `src/store/project-store.ts` — Add `convertMainToWorktree` action
- `src/components/sidebar/ProjectItem.tsx` — Add context menu item (conditionally shown) and dialog trigger
- New dialog component: `src/components/sidebar/ConvertToWorkspaceDialog.tsx` — Simple dialog with name input (branch is pre-filled/read-only since it already exists)

## Consequences

- **Better:** Users can seamlessly move feature work from main into a proper worktree
- **Better:** Main workspace stays clean on the default branch
- **Risk:** If the main workspace has uncommitted changes, `git checkout` will fail. The backend should handle this gracefully (error toast). We won't try to stash — the user should commit or stash first.
- **Tradeoff:** The dialog is simpler than NewWorkspaceDialog since we don't need branch selection or base branch — the branch already exists.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
