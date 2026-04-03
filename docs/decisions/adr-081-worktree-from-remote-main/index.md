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

# ADR-081: Base new worktrees off origin/main instead of local HEAD

## Context

When creating a new workspace (worktree) with a new branch, the current code runs `git worktree add <path> -b <branchName>` which bases the new branch off the current HEAD of the main worktree. This means if local main is behind remote, the new workspace starts from stale code.

## Decision

Modify `createWorktree()` in `electron/persistence.ts` to:
1. Always fetch `origin/<defaultBranch>` before creating a new worktree (when no existing branch is selected)
2. Pass `origin/<defaultBranch>` as the start-point to `git worktree add -b`

The first attempt becomes: `git worktree add <path> -b <branchName> origin/<defaultBranch>`

The existing fallback logic for checking out existing local/remote branches remains unchanged.

## Consequences

- New workspaces always start from the latest remote main, even if local main is stale
- Adds a network fetch before worktree creation (already happens for explicit branch selections)
- No UI changes needed

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
