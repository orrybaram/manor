---
type: adr
status: proposed
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

# ADR-065: Create Workspace from Remote Branch

## Context

Currently, the "New Workspace" dialog only supports creating a new branch or checking out a local branch. There's no way to create a workspace from a branch that exists on `origin` but hasn't been checked out locally yet. This is a common workflow — a teammate pushes a branch, and you want to spin up a worktree to review or collaborate on it.

The existing `createWorktree` in `electron/persistence.ts` tries `git worktree add <path> -b <branch>` (new branch), then falls back to `git worktree add <path> <branch>` (existing local branch). Neither handles remote-only branches.

## Decision

Add a "From remote branch" option to the New Workspace dialog that lets users pick from branches available on origin. The approach:

1. **New IPC endpoint** `projects:listRemoteBranches` — runs `git ls-remote --heads origin` in the project directory and returns branch names (stripped of `refs/heads/` prefix), excluding any branches already checked out locally as worktrees.

2. **Modify `createWorktree` in persistence.ts** — when the `-b` creation fails and the plain checkout also fails, try `git worktree add <path> --track -b <localBranch> origin/<branch>` to create a local tracking branch from the remote. This makes the existing flow work for remote branches transparently.

3. **Update NewWorkspaceDialog** — add a branch picker mode. When the user focuses the branch field, show a dropdown/combobox of remote branches fetched via the new IPC call. Selecting one auto-fills both the name and branch fields. The user can still type a custom branch name for the "create new branch" flow.

4. **Wire up preload + type definitions** — expose the new IPC through the preload bridge and `ElectronAPI` type.

## Consequences

- **Better**: Users can create worktrees from remote branches without manually running git commands
- **Better**: Supports the common "review a teammate's branch" workflow
- **Tradeoff**: `git ls-remote` requires network access and may be slow on large repos; we mitigate by fetching on-demand when the dialog opens and showing a loading state
- **Tradeoff**: Branch list can be stale if someone pushes while the dialog is open; acceptable for this use case

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
