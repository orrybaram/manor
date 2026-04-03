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

# ADR-039: Fix agent prompt race condition after workspace creation

## Context

When a user creates a workspace from an issue (via IssueDetailView), the agent prompt command is never executed. The session gets created but appears frozen with no command running.

The root cause is a race condition in the timing of `setPendingStartupCommand`:

1. `createWorktree()` is called (App.tsx:290)
2. Inside `createWorktree`, `setActiveWorkspace()` is called (project-store.ts:257), triggering React re-render
3. Terminal mounts and session creates. On success, `consumePendingStartupCommand()` finds nothing (useTerminalLifecycle.ts:164)
4. `createWorktree()` returns to App.tsx
5. App.tsx:300 calls `setPendingStartupCommand()` — too late, terminal already checked

The `worktreeStartScript` works because it's set before `setActiveWorkspace` (project-store.ts:252-255). The agent prompt is set after `createWorktree` resolves.

## Decision

Pass the agent command into `createWorktree` via an optional parameter so it can be set (combined with any worktreeStartScript) before `setActiveWorkspace` is called.

Changes:
- **`src/store/project-store.ts`**: Add optional `agentCommand` param to `createWorktree`. If both `worktreeStartScript` and `agentCommand` exist, join them with ` && `. Set the combined command before `setActiveWorkspace`.
- **`src/App.tsx`**: Build the agent command string before calling `createWorktree`, pass it in, remove the post-call `setPendingStartupCommand`.

## Consequences

- Fixes the frozen session bug
- No change to the pending command infrastructure — just ensures the command is registered before the terminal initializes
- Both worktreeStartScript and agentCommand will run when both are present

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
