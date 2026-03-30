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

# ADR-017: Show agent status indicator on collapsed projects

## Context

When a project is collapsed in the sidebar, the user has no visibility into whether agents are active in that project. They must expand the project to see the workspace agent lists. This is a usability gap — active agents (especially those waiting for input) should be visible at a glance.

## Decision

Add an `AgentDot` to the project header row that appears only when the project is collapsed and has active agents. The dot shows the highest-priority status across all workspaces in the project, using the existing priority order:

1. `requires_input` (highest — needs user decision)
2. `working`
3. `thinking`
4. `complete` (lowest displayed)

Implementation:
- Create a `useProjectAgentStatus(project)` hook that iterates all workspace paths in the project, collects non-idle agents from `paneAgentStatus`, and returns the aggregate highest-priority status
- Render `<AgentDot>` in the project header (between project name and the "+" button) when `collapsed && aggregateStatus != null`
- Reuse existing `AgentDot` component with `size="sidebar"`

Files:
- `src/components/ProjectItem.tsx` — add the hook and render the dot
- `src/hooks/useProjectAgentStatus.ts` — new hook (small, ~30 lines)

## Consequences

- Users can see at a glance which collapsed projects have active agents
- `requires_input` status is immediately visible without expanding, reducing missed prompts
- Minimal code addition — reuses existing `AgentDot`, `aggregateStatus` logic, and store selectors

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
