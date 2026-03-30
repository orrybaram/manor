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

# ADR-077: Quick Merge Worktree

## Context

Manor manages git worktrees as isolated workspaces. When a user finishes work in a worktree, they must manually switch to a terminal, checkout main, run `git merge`, then come back and delete the worktree. This is tedious for the common case where the branch is a clean fast-forward merge.

Users want a single "Merge into main" action from the workspace context menu that merges the worktree's branch into the default branch and cleans up the worktree — but only when the merge is guaranteed to be clean (fast-forward).

## Decision

Add a **"Merge & Delete"** context menu item on non-main workspaces in the sidebar. The feature:

1. **Checks mergeability** — Runs `git merge-base --is-ancestor <default-branch> <worktree-branch>` from the project root. If the default branch is an ancestor of the worktree branch, it's a clean fast-forward. If not, the action is hidden from the context menu (no merge conflicts possible).

2. **Also checks for uncommitted changes** — Runs `git status --porcelain` in the worktree. If there are uncommitted changes, the action is hidden.

3. **Performs the merge** — From the project root (main worktree): `git merge --ff-only <branch>`. The `--ff-only` flag is a safety net — it will fail if the merge isn't a fast-forward, even though we've already checked.

4. **Cleans up** — Reuses the existing `removeWorktree` flow (teardown script, worktree removal, branch deletion, session cleanup, workspace switch). Always deletes the branch since it's been merged.

### Architecture

**Electron (persistence.ts):**
- `canQuickMerge(projectId, worktreePath)` — Returns `{ canMerge: boolean, reason?: string }`. Checks: not the main worktree, no uncommitted changes, branch is fast-forwardable into default branch.
- `quickMergeWorktree(projectId, worktreePath)` — Performs ff-only merge into default branch from project root, then delegates to existing `removeWorktree(projectId, worktreePath, true)`.

**IPC (main.ts):**
- `projects:canQuickMerge` handler
- `projects:quickMergeWorktree` handler

**Renderer (electron.d.ts → project-store → ProjectItem):**
- Add `canQuickMerge` and `quickMergeWorktree` to `ElectronAPI.projects`
- Add corresponding Zustand store actions
- Add `quickMergeWorktreeWithToast` in `workspace-actions.ts` (mirrors `removeWorktreeWithToast` pattern)
- Add "Merge & Delete" context menu item in `ProjectItem.tsx`, only shown for non-main workspaces
- Check `canQuickMerge` when the context menu opens; disable/hide the item if not mergeable

### Key detail: when to check mergeability

We check `canQuickMerge` **on context menu open** (not polling). This keeps it simple and avoids unnecessary git operations. The context menu trigger fires an IPC call, and the menu item is shown/hidden based on the result. If the check is slow, we show the item as disabled with "Checking..." text briefly.

## Consequences

**Good:**
- One-click merge + cleanup for the most common worktree lifecycle
- Safe — only allows fast-forward merges, no conflict resolution needed
- Reuses existing teardown/cleanup infrastructure

**Risks:**
- Checking on context menu open adds a small delay (~50-100ms for git commands). Acceptable.
- Users might expect squash merge support — explicitly punted to v2.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
