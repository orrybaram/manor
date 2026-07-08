---
title: Canonical worktree fan-out in ProjectManager
status: todo
priority: high
assignee: sonnet
blocked_by: []
---

# Canonical worktree fan-out in ProjectManager

`electron/persistence.ts`:
- Extract `private worktreePathFor(project: PersistedProject, name: string): string`
  from the inline `baseDir`/`slug`/`path.join` logic in `createWorktree`
  (~lines 707–710). Have `createWorktree` call it. Behavior identical — no
  public signature change (it's IPC-exposed; renderer depends on the
  `ProjectInfo` return).
- Add types + method:
  ```ts
  export interface IssueSeed { number: number; title: string; url: string; body?: string | null; }
  export interface WorkspaceFromIssue { number: number; title: string; body: string | null; url: string; worktreePath?: string; error?: string; }
  async createWorkspacesFromIssues(projectId, issues: IssueSeed[], baseBranch?): Promise<WorkspaceFromIssue[]>
  ```
  Loop **sequentially** (git worktree creation must not run concurrently on one
  repo). Per issue, in try/catch: build `LinkedIssue { id:String(number),
  identifier:"#"+number, title, url }`, `name = slugify(title) || "issue-"+number`,
  `worktreePath = this.worktreePathFor(project, name)` (no set-diff), then
  `await this.createWorktree(projectId, name, undefined, linkedIssue, baseBranch)`.
  Push `{ number, title, body: body ?? null, url, worktreePath }` on success,
  `{ …, error: String(err) }` on failure.

Add a unit test in `electron/persistence.test.ts` (mirrors existing
ProjectManager tests with a mock git backend): two issue seeds → two
`createWorktree` calls with correct `linkedIssue`, results carry `worktreePath`;
one seed whose worktree creation throws still returns the other (partial success).

## Files to touch
- `electron/persistence.ts`
- `electron/persistence.test.ts`
