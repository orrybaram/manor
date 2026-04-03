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

# ADR-066: Store agent command in task metadata for correct resume

## Context

When resuming an agent session, the resume command is constructed in `src/App.tsx` `handleResumeTask`. It looks up the project's current `agentCommand` and falls back to `"claude"` if not found. This is wrong when:

1. The original session was started with a different agent command (e.g. a custom binary or alias).
2. The project has been removed or the task's workspace no longer matches any project.
3. The project's `agentCommand` was changed after the original session was created.

The correct behavior is to use whatever agent command was originally used to start the session.

## Decision

Add an `agentCommand` field to `TaskInfo` to store the original agent command at task creation time. Then use that stored command when constructing the resume command, falling back to the project's `agentCommand` and then `"claude"` only if the task predates this change.

Changes:
- `electron/task-persistence.ts`: Add `agentCommand: string | null` to `TaskInfo`
- `src/electron.d.ts`: Mirror the field in the renderer-side `TaskInfo`
- `electron/main.ts`: Pass the agent command from pane context into `createTask`
- `src/hooks/useTerminalLifecycle.ts`: Include `agentCommand` in `setPaneContext` call
- `src/App.tsx`: Use `task.agentCommand` in `handleResumeTask` instead of looking up the project

## Consequences

- Resume will always use the correct agent command, even if the project config changes or is deleted.
- Existing persisted tasks will have `agentCommand: null` and will fall back to current behavior (project lookup then `"claude"`), so this is backward-compatible.
- The pane context map and IPC type need a minor extension to carry `agentCommand`.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
