---
title: Create GitHub issue UI components
status: todo
priority: high
assignee: sonnet
blocked_by: [3]
---

# Create GitHub issue UI components

Create the GitHub-specific command palette components, mirroring the Linear ones.

## GitHubIcon.tsx

Create `src/components/CommandPalette/GitHubIcon.tsx` — simple SVG icon component with a `size` prop. Use the standard GitHub octocat mark SVG path.

```tsx
interface GitHubIconProps { size?: number }
```

## GitHubIssuesView.tsx

Create `src/components/CommandPalette/GitHubIssuesView.tsx` — mirrors `LinearIssuesView.tsx`.

Props:
```typescript
interface GitHubIssuesViewProps {
  repoPath: string;
  allIssues?: boolean;
  onSelectIssue: (issueNumber: number) => void;
}
```

- Use React Query with key `["github-issues", repoPath, allIssues]`
- Call `window.electronAPI.github.getMyIssues(repoPath, 50)` or `window.electronAPI.github.getAllIssues(repoPath, 50)` based on `allIssues` prop
- `staleTime: 0`, `refetchOnMount: "always"` (same as Linear)
- Show loading skeleton via `IssueListSkeleton`
- Render `Command.Group` with heading "My Issues" or "All Issues"
- Each item shows: `#<number>` (like Linear's identifier), title, state
- Use existing `styles.issueIdentifier`, `styles.label`, `styles.issueState` classes

## GitHubIssueDetailView.tsx

Create `src/components/CommandPalette/GitHubIssueDetailView.tsx` — mirrors `IssueDetailView.tsx`.

Props:
```typescript
interface GitHubIssueDetailViewProps {
  repoPath: string;
  issueNumber: number;
  onBack: () => void;
  onClose: () => void;
  onNewWorkspace: CommandPaletteProps["onNewWorkspace"];
}
```

- Use React Query with key `["github-issue-detail", repoPath, issueNumber]`
- Call `window.electronAPI.github.getIssueDetail(repoPath, issueNumber)`
- Show loading via `IssueDetailSkeleton`
- Layout mirrors `IssueDetailView`: detailLayout with main + sidebar
  - Main: title + body (stripped markdown using existing `stripMarkdown`)
  - Sidebar: State, Labels, Assignees (comma-joined logins), Milestone (if present)
- Branch name generation: `<number>-<slugified-title>` — slugify by lowercasing, replacing non-alphanumeric with `-`, trimming to 50 chars
- Keyboard shortcuts: Enter = create workspace (same flow as Linear — find project, check existing branch, call `onNewWorkspace`), Cmd+O = open in browser
- Footer with same hint UI as Linear detail view

For the "Create Workspace" flow: find the project whose path matches `repoPath`, then call `onNewWorkspace` with the generated branch name and issue title.

## Files to touch
- `src/components/CommandPalette/GitHubIcon.tsx` — new file
- `src/components/CommandPalette/GitHubIssuesView.tsx` — new file
- `src/components/CommandPalette/GitHubIssueDetailView.tsx` — new file
