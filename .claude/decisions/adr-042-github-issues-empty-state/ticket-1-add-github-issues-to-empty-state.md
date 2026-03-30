---
title: Add GitHub issues to WorkspaceEmptyState
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Add GitHub issues to WorkspaceEmptyState

Add a GitHub issues section to the empty state, mirroring the existing Linear tickets pattern.

## Implementation

In `src/components/WorkspaceEmptyState.tsx`:

1. Add state for GitHub: `githubAvailable`, `githubIssues`, `githubLoading`, `loadingGitHubIssueNumber`
2. In the `useMountEffect`, check GitHub status via `window.electronAPI.github.checkStatus()`. If `installed && authenticated`, fetch issues via `window.electronAPI.github.getMyIssues(project.path, 5)`.
3. Add a `handleGitHubIssueClick` callback similar to `handleTicketClick`:
   - Check if a workspace with matching branch (`{number}-{slugified-title}`) already exists
   - If yes, select it
   - If no, create worktree via `createWorktree(projectId, issueTitle, branchName)`
   - The branch name format should be `{issue.number}-{slugifiedTitle}` matching `GitHubIssueDetailView` pattern
4. Render a "Your Issues" section below the Linear tickets section (or as the only section if no Linear). Use the same CSS classes: `ticketsSection`, `ticketsSectionHeader`, `ticketRow`, `ticket`, `ticketIdentifier`, `ticketTitle`, `ticketSpinner`, `ticketLink`, `ticketLoading`.
5. The external link button opens `issue.url` via `window.electronAPI.shell.openExternal`.

Import `GitHubIssue` type from `../electron.d`.

## Files to touch
- `src/components/WorkspaceEmptyState.tsx` — add GitHub issues fetching, rendering, and click handling
