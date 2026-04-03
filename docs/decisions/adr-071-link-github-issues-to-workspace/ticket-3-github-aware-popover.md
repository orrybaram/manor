---
title: Make LinkedIssuesPopover source-aware for GitHub issues
status: done
priority: high
assignee: opus
blocked_by: [1, 2]
---

# Make LinkedIssuesPopover source-aware for GitHub issues

The `LinkedIssuesPopover` currently hardcodes Linear API calls (`linear.getIssueDetail`) and Linear-specific UI (state name, priority, assignee display name). Update it to handle both GitHub and Linear issues.

## Implementation

### Source detection

Use the same `id.startsWith("gh-")` convention to determine the source.

### Detail fetching

Currently the popover fetches all details via `linear.getIssueDetail`. Update the query to:
1. Partition issues into GitHub and Linear groups
2. Fetch GitHub issue details via `github.getIssueDetail(repoPath, number)` — extract the number from `id` (`gh-123` → `123`)
3. Fetch Linear issue details via `linear.getIssueDetail(id)` as before
4. Merge results into a single map

For GitHub issues, you need the `repoPath`. Get it from the project associated with `projectId` (available via props).

### Detail type union

Create a union or normalized type for the row display:
```typescript
type IssueDetail =
  | { source: "linear"; data: LinearIssueDetail }
  | { source: "github"; data: GitHubIssueDetail };
```

### IssueRow changes

The `IssueRow` component currently shows `detail.state.name`, `detail.assignee.displayName`. Update to handle both:
- GitHub: show `detail.state` (string), `detail.assignees[0]?.login`
- Linear: show `detail.state.name`, `detail.assignee?.displayName` (existing)

### List header

Show the appropriate icon(s) in the header — same logic as the status bar (all GitHub → GitHub icon, all Linear → Linear icon, mixed → both).

### Detail navigation

When clicking a row:
- GitHub issues → render `GitHubIssueDetailView` (with `repoPath` and `issueNumber`)
- Linear issues → render `IssueDetailView` (with `issueId`) as current

### Unlinking

Unlinking works the same for both — calls `linear.unlinkIssueFromWorkspace` which delegates to the provider-agnostic `ProjectManager.unlinkIssueFromWorkspace`.

### Error handling

GitHub uses `gh` CLI and won't have token-expiry errors like Linear. Skip the auth toast for GitHub issues; just fall back to cached data on any fetch error.

## Files to touch
- `src/components/LinkedIssuesPopover.tsx` — source detection, dual-fetch, conditional rendering, detail view routing
- `src/components/LinkedIssuesPopover.module.css` — minor adjustments if needed for GitHub-specific styling
