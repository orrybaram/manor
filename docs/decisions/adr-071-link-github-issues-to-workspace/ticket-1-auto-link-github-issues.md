---
title: Auto-link GitHub issues on workspace and task creation
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Auto-link GitHub issues on workspace and task creation

Update `GitHubIssueDetailView` to auto-link GitHub issues to workspaces, matching the pattern in `IssueDetailView` (Linear).

## Implementation

### GitHubIssueDetailView changes

**On workspace creation (`handleCreateWorkspace`):**
- When an existing workspace is found (branch match), link the issue to that workspace:
  ```typescript
  window.electronAPI.linear.linkIssueToWorkspace(project.id, existingWs.path, {
    id: `gh-${issueDetail.number}`,
    identifier: `#${issueDetail.number}`,
    title: issueDetail.title,
    url: issueDetail.url,
  });
  ```
- When creating a new workspace, pass `linkedIssue` in `onNewWorkspace`:
  ```typescript
  onNewWorkspace?.({
    projectId: project.id,
    name: issueDetail.title,
    branch: branchName,
    agentPrompt: issueDetail.title + "\n\n" + (issueDetail.body ?? ""),
    linkedIssue: {
      id: `gh-${issueDetail.number}`,
      identifier: `#${issueDetail.number}`,
      title: issueDetail.title,
      url: issueDetail.url,
    },
  });
  ```

**On task creation (`handleNewTask`):**
- Link the issue to the active workspace:
  ```typescript
  const activeWorkspacePath = useAppStore.getState().activeWorkspacePath;
  const allProjects = useProjectStore.getState().projects;
  const project = allProjects.find((p) =>
    p.workspaces.some((w) => w.path === activeWorkspacePath),
  );
  if (project && activeWorkspacePath) {
    window.electronAPI.linear.linkIssueToWorkspace(
      project.id,
      activeWorkspacePath,
      {
        id: `gh-${issueDetail.number}`,
        identifier: `#${issueDetail.number}`,
        title: issueDetail.title,
        url: issueDetail.url,
      },
    );
  }
  ```

Note: We reuse `linear.linkIssueToWorkspace` because the persistence layer is provider-agnostic — it stores `LinkedIssue` objects regardless of source. The `gh-` prefix in the ID distinguishes GitHub issues from Linear UUIDs.

## Files to touch
- `src/components/CommandPalette/GitHubIssueDetailView.tsx` — add auto-linking logic to handleCreateWorkspace and handleNewTask
