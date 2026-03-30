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

# ADR-001: Linear Issue Detail Subview in Command Palette

## Context

The command palette currently has a "linear" view that lists issues assigned to the user, with a small popover on select that offers two actions: "Create Workspace" and "Open in Browser". There's no way to see issue details (description, labels, assignee, comments, priority) without leaving the app.

Users working from Linear issues need to quickly glance at issue context — description, priority, labels — before deciding to create a workspace or continue browsing. The current popover is too minimal for this.

## Decision

Add a third palette view `"issue-detail"` that shows full issue details inline in the command palette. When a user selects an issue in the `"linear"` view, instead of opening the small action popover, navigate to the `"issue-detail"` view which displays:

- Issue identifier + title in the breadcrumb
- Description (markdown rendered as plain text, truncated)
- Priority indicator
- State badge
- Labels
- Assignee name
- Action items at the bottom (Create Workspace, Open in Browser — same as current popover)

### Implementation approach

1. **Extend the `LinearIssue` type** to include `description`, `labels`, and `assignee` fields. Update the GraphQL query in `electron/linear.ts` to fetch these fields.

2. **Add a new `getIssueDetail` method** to `LinearManager` that fetches a single issue by ID with full detail (description, comments are heavier — fetch on demand rather than in the list query). This keeps the list query fast.

3. **Wire the new IPC handler** through `electron/main.ts` and `electron/preload.ts`, and add the type to `src/electron.d.ts`.

4. **Add the `"issue-detail"` view** to `CommandPalette.tsx`. Replace the popover approach: selecting an issue navigates to the detail view. Use react-query to fetch full issue data on demand. The breadcrumb shows "Linear Issues > MAN-123" with back navigation.

5. **Style the detail view** in `CommandPalette.module.css` — a scrollable content area with the issue metadata and description, action buttons pinned at the bottom.

### Data flow

```
User selects issue in "linear" view
  → setView("issue-detail"), setSelectedIssueId(id)
  → react-query fetches getIssueDetail(id)
  → Renders detail view with loading state
  → Action buttons at bottom (Create Workspace / Open in Browser)
  → Back button returns to "linear" view (preserving cached list)
```

## Consequences

- **Better**: Users can read issue context without switching to browser. Faster workflow for deciding which issue to work on.
- **Tradeoff**: Slightly more complex palette state (3 views instead of 2). The popover pattern is removed — selecting an issue always drills in.
- **Risk**: Linear API rate limits — mitigated by react-query caching with a reasonable stale time.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
