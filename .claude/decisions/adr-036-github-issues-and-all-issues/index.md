---
type: adr
status: proposed
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

# ADR-036: GitHub Issue Integration & "All Issues" for Both Providers

## Context

Manor has a full Linear ticket integration — users can browse "My Issues" in the command palette, view issue details, and create workspaces from issues. GitHub integration currently only supports PR status badges via the `gh` CLI.

The user wants:
1. **GitHub issue browsing** that mirrors the Linear ticket experience — browse issues in the command palette, view details, create workspaces.
2. **"All Issues" option** for both Linear and GitHub — a second list item below "My Issues" showing 50 issues sorted by priority (not limited to the authenticated user's assignments).

## Decision

### GitHub Issues Backend (`electron/github.ts`)

Extend `GitHubManager` with three new methods, all using the `gh` CLI (no new auth — reuses existing `gh auth`):

- **`getMyIssues(repoPath, limit?)`** — runs `gh issue list --assignee @me --state open --json number,title,url,state,labels,assignees --limit <limit>` against the repo at `repoPath`. Returns issues sorted by number descending (newest first). No separate priority field in GitHub issues, so sort by issue number as a proxy for recency.
- **`getAllIssues(repoPath, limit?)`** — runs `gh issue list --state open --json number,title,url,state,labels,assignees --sort created --limit <limit>`. Returns 50 issues.
- **`getIssueDetail(repoPath, issueNumber)`** — runs `gh issue view <number> --json number,title,url,state,body,labels,assignees,milestone`. Returns full issue detail.

Data models:

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

GitHub issues don't have a `branchName` field. When creating a workspace, generate a branch name from the issue: `<number>-<slugified-title>` (e.g., `42-fix-login-bug`).

### Linear "All Issues" Backend (`electron/linear.ts`)

Add `getAllIssues(teamIds, options?)` method to `LinearManager`. This queries `issues` on the team (not `viewer.assignedIssues`), filtering by team and state types, ordered by priority. Returns up to 50 issues.

### IPC Layer

New handlers in `main.ts` + `preload.ts`:
- `github:getMyIssues(repoPath, limit?)`
- `github:getAllIssues(repoPath, limit?)`
- `github:getIssueDetail(repoPath, issueNumber)`
- `linear:getAllIssues(teamIds, options?)`

### Type Definitions (`electron.d.ts`)

Add `GitHubIssue`, `GitHubIssueDetail` interfaces and extend `ElectronAPI.github` with the new methods. Extend `ElectronAPI.linear` with `getAllIssues`.

### Command Palette UI

**New views/navigation:**
- `PaletteView` type expands: `"root" | "linear" | "linear-all" | "github" | "github-all" | "issue-detail" | "github-issue-detail"`
- Root view gets a "GitHub" group (when `gh` is authenticated) with two items: "My Issues" and "All Issues"
- Root view's "Linear" group gets a second item: "All Issues" (below existing "My Issues")

**New components:**
- `GitHubIssuesView.tsx` — mirrors `LinearIssuesView.tsx`, takes `repoPath` and an `allIssues` boolean prop. Uses `github:getMyIssues` or `github:getAllIssues` depending on the prop.
- `GitHubIssueDetailView.tsx` — mirrors `IssueDetailView.tsx` but for GitHub issues. Shows body (markdown stripped), state, labels, assignees, milestone. Same keyboard shortcuts: Enter = create workspace, Cmd+O = open in browser.
- `GitHubIcon.tsx` — GitHub SVG icon component.

**Shared `IssueDetailView` consideration:** The existing `IssueDetailView.tsx` is tightly coupled to Linear types. Rather than generalizing it (which would add complexity for marginal benefit), create a parallel `GitHubIssueDetailView.tsx`. Both are simple enough that duplication is better than abstraction here.

**`repoPath` resolution:** The command palette knows the active workspace path from the app store. Use the project's main path (repo root) as `repoPath` for GitHub API calls. No project-level "GitHub association" config needed — `gh` works against whatever repo is at that path.

**`LinearIssuesView.tsx` changes:** Accept an `allIssues` prop. When true, call `linear:getAllIssues` instead of `linear:getMyIssues`. Heading changes to "All Issues". The "linear" view uses `allIssues=false`, the "linear-all" view uses `allIssues=true`.

**`WorkspaceEmptyState.tsx`:** No changes for now — it currently shows top 5 Linear issues. GitHub issues can be added there in a follow-up.

### Navigation Flow

```
Root
├── Linear (group)
│   ├── My Issues    → view: "linear"      → LinearIssuesView (allIssues=false)
│   └── All Issues   → view: "linear-all"  → LinearIssuesView (allIssues=true)
├── GitHub (group)
│   ├── My Issues    → view: "github"      → GitHubIssuesView (allIssues=false)
│   └── All Issues   → view: "github-all"  → GitHubIssuesView (allIssues=true)

Issue click → view: "issue-detail" (Linear) or "github-issue-detail" (GitHub)
```

## Consequences

**Positive:**
- Users can browse and act on GitHub issues the same way they do Linear issues.
- "All Issues" gives visibility into the full team backlog for both providers.
- No new authentication — GitHub uses existing `gh` CLI auth.
- No new project-level configuration — GitHub repos are auto-detected from workspace paths.

**Tradeoffs:**
- GitHub issue fetching depends on `gh` CLI being installed and authenticated (same as PR badges).
- GitHub issues lack some Linear-specific fields (priority number, branch name) — we generate branch names and sort by recency instead.
- Two parallel detail view components (Linear + GitHub) means some visual duplication, but keeps each simple and provider-specific.

**Risks:**
- `gh issue list` can be slow on repos with many issues. The 50-issue limit and `--limit` flag mitigate this.
- Generated branch names (`42-fix-login-bug`) may conflict with existing branches — the worktree creation flow already handles this.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
