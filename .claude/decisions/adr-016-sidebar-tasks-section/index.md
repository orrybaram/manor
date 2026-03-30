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

# ADR-016: Sidebar Tasks Section

## Context

Active agents are currently shown in two places:
1. **Per-workspace agent accordion** — nested inside each project's workspace list in the sidebar (`WorkspaceAgentList` in `ProjectItem.tsx`). Only visible when the project is expanded.
2. **AgentDebugPanel** — a fixed overlay in the bottom-right corner showing raw pane/agent data. Useful for debugging but not user-friendly.

The user wants a single, top-level "Tasks" section in the sidebar that aggregates all active agents across all projects. This provides a quick overview of everything running and enables one-click navigation to any agent. The debug panel should be removed.

## Decision

Create a new `TasksList` component modeled after `PortsList` — a collapsible section in the sidebar placed above the Ports section. It will:

1. **Aggregate agents across all projects** using a new `useAllAgents` hook that iterates all projects → workspaces → sessions → panes and collects non-idle agents, enriched with project name, workspace index, and project index for navigation.

2. **Group by project** (like `PortGroup` groups by workspace for ports). Each group shows the project name as a header, with individual agent items beneath.

3. **Navigate on click** — clicking a task item will: select the project, select the workspace, select the session, and focus the pane.

4. **Remove `AgentDebugPanel`** from `App.tsx`.

5. **Remove per-workspace `WorkspaceAgentList`** from `ProjectItem.tsx` since the new top-level section replaces it.

6. **Reuse existing components** — `AgentDot`, `AgentItemLabel`, `cleanAgentTitle`, `useDebouncedAgentStatus`, and the existing sidebar CSS patterns (`.agentItem`, `.agentName`, etc.).

## Consequences

- Single place to see all running agents regardless of which project is selected or expanded
- Removes debug-only panel in favor of production-quality UI
- Per-workspace agent lists under projects go away — slight loss of workspace-level grouping, but the tasks section groups by project which is more useful at a glance
- Navigation is simpler: one click from tasks section vs expanding project → finding workspace → expanding tasks accordion

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
