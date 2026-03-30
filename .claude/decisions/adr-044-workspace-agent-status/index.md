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

# ADR-044: Add Agent Status to Workspace Items in Project List

## Context

Workspace items in the sidebar project list currently show static icons — `House` for the main workspace and `FolderGit2` for worktrees. Agent status is shown at the project level (when collapsed) and at the pane level, but not at the workspace level. Users need to see which workspace has active agents without expanding into individual sessions.

## Decision

Replace the static workspace icons with `AgentDot` when a workspace has active agent status, falling back to the original icons when idle/no agents.

1. **Create `useWorkspaceAgentStatus` hook** — mirrors `useProjectAgentStatus` but scoped to a single workspace path. Returns the highest-priority non-idle `AgentStatus` or `null`.

2. **Create `WorkspaceIcon` component** — renders `AgentDot` when there's an active status, otherwise falls back to `House`/`FolderGit2`. This keeps the icon area consistent in size.

3. **Update `ProjectItem.tsx`** — replace the inline icon logic with the new `WorkspaceIcon` component.

## Consequences

- Users get at-a-glance visibility into which workspace has active agents
- Reuses existing `AgentDot` component and `STATUS_PRIORITY` logic — no new visual primitives
- Minimal code change: one new hook (~20 lines), one small component, one edit to ProjectItem

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
