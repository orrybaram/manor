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

# ADR-042: Show Top 5 GitHub Issues in Empty State

## Context

The `WorkspaceEmptyState` component currently shows Linear tickets when a project has Linear associations, but does not show GitHub issues. Since the app already has full GitHub integration (via `gh` CLI), users with GitHub repos should see their top 5 assigned issues in the empty state, matching the Linear tickets pattern.

## Decision

Add a GitHub issues section to `WorkspaceEmptyState` that:
1. Checks GitHub availability via `checkStatus()` on mount
2. If GitHub is connected, fetches up to 5 issues via `getMyIssues(project.path, 5)`
3. Renders them in a "Your Issues" section using the same ticket row styling as Linear tickets
4. Clicking an issue creates a worktree workspace (branch: `{number}-{slugified-title}`) or navigates to an existing workspace with matching branch — same pattern as Linear ticket click
5. Shows an external link button to open the issue on GitHub
6. Shows loading skeletons while fetching (3 rows, same as Linear)
7. Both sections can coexist — Linear tickets show first, then GitHub issues

The implementation reuses the existing `EmptyStateShell` by passing a combined `ticketsSection` that includes both Linear and GitHub sections.

## Consequences

- Users with GitHub repos see actionable issues immediately in the empty state
- No new dependencies — reuses existing `electronAPI.github` methods and CSS classes
- The `ticketsSection` prop on `EmptyStateShell` now contains potentially two sections
- If both Linear and GitHub are connected, the empty state gets taller — acceptable since the content is valuable

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
