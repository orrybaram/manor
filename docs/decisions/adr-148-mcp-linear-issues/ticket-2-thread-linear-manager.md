---
title: Thread LinearManager into the control server and add issue routes
status: done
priority: critical
assignee: opus
blocked_by: [1]
---

# Thread LinearManager into the control server and add issue routes

Wire the already-constructed `LinearManager` down to `handleControlRequest`, then teach the
issues route about `source` and add a detail route. Uses `electron/issue-sources.ts` from
ticket 1.

## Wiring

`LinearManager` must not leak into the MCP process — it imports `safeStorage` from
`electron`. It only travels along the existing Electron-side chain:

- `ControlDeps` (`control-server.ts:14`) gains `linearManager: LinearManager | null`.
- `WebviewServer` (`webview-server.ts:54`) gains a private `linearManager` field and a
  fourth optional constructor param, defaulted to `null` like `githubManager`.
- The deps object literal at `webview-server.ts:232` passes it through.
- `createWebviewServer` (`electron/ipc/webview.ts:34`) gains a matching optional param.
- `app-lifecycle.ts:206` passes the `linearManager` already built at line 142.

## `GET /projects/:id/issues` — add `source`

Replace the body of the `sub === "issues" && !subsub` branch (`control-server.ts:143-168`):

- Parse `source` from the querystring; default `"github"`. If present and not a valid
  `IssueSource`, `json(400, { error: "Unknown source '<v>'. Use 'github' or 'linear'." })`.
- Parse `state` via `parseIssueState`, `limit` as today (finite, > 0, else 50), `filter` as
  today (`"all"` vs `"assigned"`).
- **github** — unchanged calls, but map results through `normalizeGitHubIssue`.
- **linear** —
  - `deps.linearManager` null or `!linearManager.isConnected()` →
    `json(503, { error: "Linear is not connected. Connect Linear in Manor settings." })`
  - `project.linearAssociations` empty →
    `json(400, { error: "Project has no Linear team associated." })`
  - else `teamIds = project.linearAssociations.map(a => a.teamId)` and
    `filter === "all" ? getAllIssues(teamIds, opts) : getMyIssues(teamIds, opts)` with
    `opts = { stateTypes: linearStateTypes(state), limit }`. Map through
    `normalizeLinearIssue`.

**Error handling matters here.** `LinearManager` throws on a bad/expired token, unlike
`GitHubManager` which swallows and returns `[]`. Wrap the Linear calls in try/catch and
respond `json(502, { error: String(err) })` — an unhandled rejection in main is not
acceptable. Do the same for the detail route.

## `GET /projects/:id/issues/:issueRef` — new

Add a branch for `sub === "issues" && subsub` (the `subsub` variable already exists at
`control-server.ts:111`). Non-GET → 405.

- Read `source` the same way (default `"github"`, unknown → 400).
- **github** — `issueRef` must parse as a positive integer via `Number.parseInt`, else
  `json(400, { error: "GitHub issue refs must be numeric." })`. Then
  `github.getIssueDetail(project.path, n)` → `normalizeGitHubIssueDetail`. 503 if no
  `githubManager`, matching the listing route.
- **linear** — same connected / associated guards as the listing route, then
  `linearManager.getIssueDetail(decodeURIComponent(issueRef))` → `normalizeLinearIssueDetail`.
  Pass the ref through verbatim: Linear's `issue(id:)` GraphQL query resolves both a UUID
  and a human identifier like `ENG-123`, so the value returned by the listing round-trips.

Both respond `json(200, detail)`.

## Out of scope

`batch_create_workspaces` (`POST /projects/:id/workspaces/batch`) stays GitHub-only. Its
`issues: number[]` validation and `renderPrompt`'s `"Work on GitHub issue #{number}"`
template both assume numeric refs. Do not touch it — but if the request carries
`source=linear`, reject with
`json(400, { error: "batch_create_workspaces supports GitHub issues only." })` rather than
silently treating it as GitHub.

## Files to touch

- `electron/control-server.ts` — `ControlDeps.linearManager`; rewrite the issues branch to
  switch on `source`; add the `:issueRef` detail branch; guard the batch route against
  `source=linear`. Import the normalizers and `linearStateTypes` from `./issue-sources`,
  and `import type { LinearManager } from "./linear"`.
- `electron/webview-server.ts` — constructor param + private field + pass into
  `handleControlRequest`'s deps literal (~line 232).
- `electron/ipc/webview.ts` — `createWebviewServer` third param, forwarded to
  `new WebviewServer(...)`.
- `electron/app-lifecycle.ts` — pass `linearManager` at the `createWebviewServer` call
  (~line 206). It is already in scope from line 142.
