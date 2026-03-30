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

# ADR-047: Add Breadcrumbs to Main Content Window

## Context

The main content area has no visual indicator of which project and workspace the user is currently viewing. When multiple projects and workspaces exist, users need a quick way to see their current location.

## Decision

Add a breadcrumb bar at the top of `.main-content` (above the TabBar) showing `ProjectName > WorkspaceName`. The breadcrumb derives data from the active workspace path by finding the matching project in `useProjectStore` and the matching workspace within it.

- New component: `src/components/Breadcrumbs.tsx` with CSS module
- Renders between sidebar and TabBar in `App.tsx`
- Shows `projectName > workspaceName` where workspace name falls back to branch name or "main"
- Styled as a compact, non-interactive text bar with drag region for window dragging
- Hidden when no workspace is active

## Consequences

- Improves orientation for users working across multiple projects/workspaces
- Adds a small amount of vertical space above the tab bar
- Simple implementation with no new state or store changes

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
