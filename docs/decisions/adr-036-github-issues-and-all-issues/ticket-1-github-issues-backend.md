---
title: Add GitHub issue fetching to GitHubManager
status: todo
priority: high
assignee: sonnet
blocked_by: []
---

# Add GitHub issue fetching to GitHubManager

Add three new methods to `GitHubManager` in `electron/github.ts` for fetching GitHub issues via the `gh` CLI.

## Data Models

Add these interfaces to `electron/github.ts`:

```typescript
interface GitHubIssue {
  number: number;
  title: string;
  url: string;
  state: string;
  labels: Array<{ name: string; color: string }>;
  assignees: Array<{ login: string }>;
}

interface GitHubIssueDetail extends GitHubIssue {
  body: string | null;
  milestone: { title: string } | null;
}
```

## Methods to Add

### `getMyIssues(repoPath: string, limit?: number): Promise<GitHubIssue[]>`
- Run: `gh issue list --assignee @me --state open --json number,title,url,state,labels,assignees --limit <limit|50>`
- `cwd` set to `repoPath`, timeout 10000ms
- Parse JSON output, return array
- On error, return empty array

### `getAllIssues(repoPath: string, limit?: number): Promise<GitHubIssue[]>`
- Run: `gh issue list --state open --json number,title,url,state,labels,assignees --sort created --limit <limit|50>`
- Same error handling

### `getIssueDetail(repoPath: string, issueNumber: number): Promise<GitHubIssueDetail>`
- Run: `gh issue view <issueNumber> --json number,title,url,state,body,labels,assignees,milestone`
- `cwd` set to `repoPath`, timeout 10000ms
- Parse JSON, return object
- On error, throw

## Files to touch
- `electron/github.ts` — add interfaces and three new methods to `GitHubManager`
