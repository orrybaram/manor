---
title: GitHub issue + batch-workspace HTTP routes
status: todo
priority: high
assignee: sonnet
blocked_by: [1]
---

# GitHub issue + batch-workspace HTTP routes

Add HTTP endpoints for listing issues and fanning out issues into workspaces.
Depends on ticket 1 (`WebviewServer.startAgent`).

## Inject GitHubManager into WebviewServer

In `electron/webview-server.ts`:
- Import `type { GitHubManager } from "./github"`.
- Add constructor param 3: `githubManager?: GitHubManager`, store as
  `this.githubManager = githubManager ?? null`. **Keep params 1–2 unchanged** so
  existing call sites and tests (`new WebviewServer(registry, projectManager)`)
  still compile.

In `electron/ipc/webview.ts`:
- `createWebviewServer(projectManager?, githubManager?)` — thread the new param
  into the constructor.

In `electron/app-lifecycle.ts`:
- Pass the existing `githubManager` instance to
  `webviewIpc.createWebviewServer(projectManager, githubManager)`. (Confirm the
  variable name where `GitHubManager` is constructed; it is already built during
  lifecycle setup and lives on `ipcDeps.githubManager`.)

## Routes

Add to `handleProjectRequest` (it already resolves `project` from `projectId`).

### `GET /projects/:id/issues`
- Query params: `filter` (`assigned` default | `all`), `state`
  (`open` default | `closed` | `all`), `limit` (default 50).
- If `!this.githubManager`, `json(503, { error: "GitHub is not available" })`.
- `filter === "all"` → `github.getAllIssues(project.path, limit, state)`,
  else `github.getMyIssues(project.path, limit, state)`.
- `json(200, issues)`.

### `POST /projects/:id/workspaces/batch`
- Body: `{ issues: number[], baseBranch?: string, assign?: boolean,
  startAgent?: boolean, promptTemplate?: string }`.
- Validate `issues` is a non-empty array of numbers → else `json(400, …)`.
- Require `this.githubManager` and `this.projectManager` → else `json(503, …)`.
- For each `number` in `issues`, wrapped in try/catch (collect per-issue errors,
  never abort the batch):
  1. `const detail = await github.getIssueDetail(project.path, number)`.
  2. Build `linkedIssue: LinkedIssue = { id: String(number),
     identifier: "#" + number, title: detail.title, url: detail.url }`
     (import `type { LinkedIssue } from "./linear"`).
  3. `const name = slugify(detail.title) || "issue-" + number` — add a local
     `slugify` (copy the one in `persistence.ts:22`) or export & reuse it.
  4. `const updated = await pm.createWorktree(projectId, name, undefined,
     linkedIssue, baseBranch)`.
  5. Resolve the new worktree path: find the workspace in `updated.workspaces`
     whose `name`/branch matches, or (simplest) the entry not present before the
     call. A robust approach: `createWorktree` builds the path from
     `slugify(name)`; recompute the same path, or diff `updated.workspaces`
     against the pre-call list. Prefer diffing to avoid path-logic duplication.
  6. If `assign`, `await github.assignIssue(project.path, number)` (fire-and-forget ok).
  7. If `startAgent !== false`, render the prompt
     (`promptTemplate` with `{number}`/`{title}`/`{body}` substituted, else
     default `Work on GitHub issue #<number>: <title>.\n\n<body>`), then
     `this.startAgent(worktreePath, prompt)`.
  8. Push `{ number, title: detail.title, workspacePath: worktreePath,
     started: <bool>, error?: string }`.
- `json(200, { results })`.

> Note the sequencing: create the worktree first, then `startAgent` (which makes
> the renderer `loadProjects()` and select it). Starting multiple agents in a
> tight loop is fine — each `app-command` opens its own tab.

## Verification
- `pnpm build` succeeds.
- `pnpm test` — existing `mcp-webview-server.test.ts` still green (constructor
  back-compat).

## Files to touch
- `electron/webview-server.ts` — GitHubManager field, `/issues` + `/batch` routes, `slugify`, `LinkedIssue` import
- `electron/ipc/webview.ts` — thread `githubManager`
- `electron/app-lifecycle.ts` — pass `githubManager` to `createWebviewServer`
