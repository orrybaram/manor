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

# ADR-092: Redesign New Workspace Dialog — Separate Base Branch from Branch Name

## Context

The current `NewWorkspaceDialog` has a "Branch" field that serves a confusing dual purpose: users can either search for a remote branch to check out, or leave it blank to auto-derive a branch name from the workspace name. The backend always bases new branches off `origin/{defaultBranch}` (typically `origin/main`), with no way to choose a different base.

The user wants three distinct concepts:
1. **Workspace name** — display name for the workspace (already exists)
2. **Base branch** — which branch to base the new workspace off of (currently hardcoded to `origin/main`)
3. **Branch name** — the git branch name for the new worktree (currently a confusing input field)

## Decision

Redesign the dialog to separate these concerns:

### UI Changes (NewWorkspaceDialog.tsx)
- **Name field**: Keep as-is. User types a workspace display name.
- **Base branch picker**: Replace the current "Branch" combobox with a "Base branch" combobox. This determines what branch the new worktree is based off of. Default selection is `main` (local). Include `origin/main` as an explicit option plus all remote branches from the existing `listRemoteBranches` query.
- **Branch name**: Auto-derived from `slugify(name)`. Shown as a read-only hint below the name field (e.g., "Branch: `my-feature`") so the user knows what branch will be created. No manual editing.

### Backend Changes (persistence.ts)
- `createWorktree` signature changes: add a `baseBranch?: string` parameter. When provided, use it as the base ref instead of `origin/{defaultBranch}`.
- Update the `git worktree add` call: `git worktree add <path> -b <branchName> <baseBranch>`.

### IPC/Type Changes
- Update `electron/preload.ts`, `electron/main.ts`, `src/electron.d.ts` to pass `baseBranch` through the IPC bridge.
- Update `onSubmit` callback signature to include `baseBranch`.
- Update callers in `App.tsx` and `project-store.ts`.

### Branch list composition
The base branch dropdown should show:
- `main` (or `project.defaultBranch`) — local default branch, selected by default
- `origin/main` (or `origin/{defaultBranch}`) — explicit remote option
- All other remote branches from `listRemoteBranches` (already fetched), prefixed with `origin/`

## Consequences

- **Better UX**: Clear separation of "what to name it" vs "what to base it off of" vs "what branch to create".
- **More flexibility**: Users can base workspaces off any branch, not just main.
- **Breaking change**: The `onSubmit` signature and `createWorktree` IPC contract change. All callers must be updated.
- **Simpler dialog**: Removing the manual branch name input reduces cognitive load.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
