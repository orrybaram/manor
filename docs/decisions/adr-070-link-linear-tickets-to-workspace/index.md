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

# ADR-070: Link Linear Tickets to Workspaces

## Context

When a workspace is created from a Linear issue (or a task is started from one), the connection between the workspace and the originating ticket is lost immediately. The issue ID is used to start the issue and name the branch, but nothing persists the relationship. Users forget which ticket a workspace is for, can't see ticket status without leaving Manor, and have no way to quickly navigate back to the ticket.

The existing Linear integration already handles auth (encrypted token in safe storage), issue fetching (GraphQL API), and workspace creation from issues. What's missing is the persistent link and its UI surface.

## Decision

### Data Model

Add a `LinkedIssue` type and persist linked issues per workspace in `projects.json`, following the established pattern used by `workspaceNames` and `workspaceOrder`.

**New type** (in `electron/linear.ts`):
```typescript
export interface LinkedIssue {
  id: string;           // Linear issue ID (UUID)
  identifier: string;   // e.g. "ENG-123"
  title: string;        // issue title at time of linking
  url: string;          // Linear URL for opening in browser
}
```

**Persistence** (in `electron/persistence.ts`):
- Add `workspaceIssues?: Record<string, LinkedIssue[]>` to `PersistedProject` — keyed by workspace path, same as `workspaceNames`.
- Hydrate into `WorkspaceInfo.linkedIssues?: LinkedIssue[]` during `buildProjectInfo()`.
- Add IPC methods: `linkIssueToWorkspace(projectId, workspacePath, issue)`, `unlinkIssueFromWorkspace(projectId, workspacePath, issueId)`, and `getWorkspaceIssues(projectId, workspacePath)`.
- Clean up entries in `removeWorktree()` when a workspace is deleted.

### Auto-Linking Triggers

1. **Create workspace from Linear issue** (`IssueDetailView.handleCreateWorkspace`): After `onNewWorkspace()` resolves and the workspace path is known, call `linkIssueToWorkspace`. Also link when switching to an existing workspace for that branch.

2. **Create task from Linear issue** (`IssueDetailView.handleNewTask`): The task is created in the currently active workspace. After calling `onNewTaskWithPrompt()`, link the issue to `activeWorkspacePath`.

Both flows already have the issue data (`id`, `identifier`, `title`, `url`) available — no additional API calls needed.

### Status Bar UI

Extend `StatusBar.tsx` to show linked issues after the workspace label:

- **0 issues**: Nothing shown (no Linear section at all).
- **1 issue**: `[LinearIcon] ENG-123` — clickable.
- **2+ issues**: `[LinearIcon] N issues` — clickable.

Use the existing `LinearIcon` component (from `CommandPalette/LinearIcon.tsx`) at a small size (12-14px).

### Popover (click to expand)

Clicking the Linear section in the status bar opens a popover anchored to it. The popover shows a list of linked issues with basic details:

- **Cached data** (from `LinkedIssue`): identifier, title — shown immediately, no fetch needed.
- **Live data** (fetched on popover open): status, assignee, priority — fetched via `linear.getIssueDetail()` for each linked issue.
- Loading state while fetching live data.
- Each issue row is clickable — opens the existing `IssueDetailView` (reused from the command palette).
- Right-click on an issue row shows a context menu with "Unlink issue" option.

### Error Handling

If `getIssueDetail()` fails due to an expired/invalid token:
- Show an error toast using the existing toast system (`useToastStore`).
- Include an action button ("Open Settings") that navigates to the integrations settings page.
- The popover shows cached data (identifier + title) without live details, so it degrades gracefully.

### IssueDetailView Reuse

The `IssueDetailView` component currently lives in the command palette and receives `onBack`, `onClose`, `onNewWorkspace`, and `onNewTaskWithPrompt` props. To reuse it from the status bar popover:

- The popover will render `IssueDetailView` inline when an issue is clicked, passing appropriate callbacks.
- `onBack` returns to the popover list view.
- `onClose` closes the popover entirely.

## Consequences

**Positive:**
- Users always know which ticket a workspace is for without leaving Manor.
- Cached identifiers mean the status bar renders instantly with no API calls.
- Follows established persistence patterns (`workspaceNames`, `workspaceOrder`), so the code is consistent.
- Popover + IssueDetailView reuse avoids building new UI for issue details.
- Toast action button pattern already exists, so error UX is free.

**Negative:**
- `LinkedIssue.title` is cached at link time and can go stale if renamed in Linear. Acceptable since the popover fetches live data on open.
- Multiple linked issues add popover complexity (list → detail navigation).
- No manual "Link issue" command palette action in v1 — users can only link through the create-workspace or create-task flows.

**Future extensions (not in this ADR):**
- Command palette action to manually link/search issues to a workspace.
- GitHub Issues support (similar `LinkedIssue` abstraction).
- Lifecycle sync (workspace deletion → update ticket state).
- Two-way sync (ticket state changes reflected in Manor).

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
