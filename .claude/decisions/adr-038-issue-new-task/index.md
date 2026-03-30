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

# ADR-038: Add "New Task" option in issue detail view

## Context

When viewing an issue detail (Linear or GitHub) in the command palette, the only action is "Start Work" (Enter) which creates a new workspace (git worktree) and auto-starts an agent with the issue prompt. Sometimes users want to work on an issue in their **current** workspace instead of creating a new one — for example, small fixes that don't warrant a separate branch, or when they already have the right workspace open.

## Decision

Add a second action in both `IssueDetailView` and `GitHubIssueDetailView` triggered by `Shift+Enter` that creates a new task (session/tab) in the current workspace with the issue prompt pre-filled, without creating a new workspace or switching branches. This reuses the existing `handleNewTask` pattern from App.tsx but passes the issue's title + description as the agent prompt.

**Changes:**

1. **`CommandPaletteProps`** (`types.ts`) — Add `onNewTaskWithPrompt?: (prompt: string) => void` callback.

2. **`IssueDetailView.tsx`** — Add `Shift+Enter` handler that calls `onNewTaskWithPrompt` with the issue prompt. Add footer hint. Also update issue state in Linear (same as workspace flow).

3. **`GitHubIssueDetailView.tsx`** — Same pattern: `Shift+Enter` → `onNewTaskWithPrompt`. Also assign issue in GitHub.

4. **`App.tsx`** — Create `handleNewTaskWithPrompt(prompt: string)` that works like `handleNewTask` but passes the agent command with the prompt string (same escaping as the workspace flow). Wire it through to `CommandPalette`.

5. **`CommandPalette.tsx`** — Thread `onNewTaskWithPrompt` down to both issue detail views.

## Consequences

- Users get a lightweight alternative to workspace creation — stays in current branch/workspace.
- Both Linear and GitHub issue detail views gain identical UX.
- No backend/electron changes needed — reuses existing `setPendingStartupCommand` + `addSession` pattern.
- `Shift+Enter` is consistent with the existing `Enter` for "Start Work" — easy to discover via the footer hints.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
