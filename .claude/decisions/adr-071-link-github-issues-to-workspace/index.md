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

# ADR-071: Link GitHub Issues to Workspaces

## Context

ADR-070 added linked issue tracking for Linear issues — when a workspace is created from a Linear issue or a task is started, the issue is auto-linked and visible in the status bar with a popover for live details. GitHub issues have no equivalent. When a user creates a workspace or task from a GitHub issue (via the command palette), the connection is immediately lost. There's no way to see which GitHub issue a workspace relates to without leaving Manor.

The existing `LinkedIssue` type (`{ id, identifier, title, url }`) and the `workspaceIssues` persistence map are provider-agnostic — they store a string `id`, a human-readable `identifier`, a `title`, and a `url`. GitHub issues fit this shape naturally: `id` = `"gh-{number}"`, `identifier` = `"#123"`, `title` and `url` from the API.

## Decision

Extend the existing linked-issues infrastructure to support GitHub issues alongside Linear issues. The approach mirrors ADR-070 exactly, reusing the same `LinkedIssue` type, persistence layer, and link/unlink IPC — no new persistence schema needed.

### Changes

1. **Auto-link on workspace/task creation** — Update `GitHubIssueDetailView` to call `linkIssueToWorkspace` when creating a workspace or task, matching the pattern in `IssueDetailView` (Linear). Pass a `linkedIssue` on `onNewWorkspace` for new worktrees. For tasks, link to the active workspace.

2. **GitHub-aware status bar** — The status bar currently only shows a Linear icon for linked issues. Update it to detect the issue source from the `id` prefix (`gh-` = GitHub, otherwise Linear) and render the appropriate icon. When mixed, show a generic icon or both.

3. **GitHub-aware popover** — The `LinkedIssuesPopover` currently hardcodes Linear API calls and icons. Make it source-aware: for GitHub issues, call `github.getIssueDetail()` and show GitHub-specific fields (state, labels, assignees, milestone) instead of Linear fields (status, priority, assignee). The list view shows rows for both sources. The detail view routes to `GitHubIssueDetailView` for GitHub issues and `IssueDetailView` for Linear issues.

4. **IPC bridge for GitHub link/unlink** — Add `github:linkIssueToWorkspace` and `github:unlinkIssueFromWorkspace` IPC handlers that delegate to the same `ProjectManager.linkIssueToWorkspace` / `unlinkIssueFromWorkspace` methods. This is a thin alias so the renderer can call either `linear.linkIssueToWorkspace` or `github.linkIssueToWorkspace` — both hit the same persistence. Alternatively, expose a single provider-agnostic `issues:linkToWorkspace` channel.

### ID Convention

GitHub issues use `id: "gh-{number}"` to avoid collisions with Linear UUIDs. The `identifier` is `"#{number}"` (e.g., `"#42"`).

## Consequences

**Positive:**
- Users see which GitHub issue a workspace is for at a glance
- Reuses existing `LinkedIssue` type and persistence — no migration needed
- Consistent UX across both issue providers
- Cached identifiers render instantly, live details fetched on popover open

**Negative:**
- The popover and status bar gain source-detection logic, adding conditional rendering
- No manual link action in v1 (same limitation as Linear)
- Cached titles can go stale if renamed on GitHub (same tradeoff as Linear)

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
