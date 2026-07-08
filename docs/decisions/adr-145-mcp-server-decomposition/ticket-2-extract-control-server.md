---
title: Extract control-server.ts; slim WebviewServer under 1k
status: todo
priority: high
assignee: sonnet
blocked_by: [1]
---

# Extract control-server.ts; slim WebviewServer under 1k

New `electron/control-server.ts`:
- `export function startAgent(workspacePath, prompt?): { ok, error? }` (the
  `BrowserWindow.getAllWindows()[0].webContents.send("app-command", …)` bridge,
  moved verbatim from WebviewServer).
- `export async function handleControlRequest(deps, method, url, json, readBody):
  Promise<boolean>` where `deps = { projectManager, githubManager }`. Returns
  `true` iff it handled the route (matched `/projects…` or `/agents`).
- Dispatch on `url.pathname.split("/").filter(Boolean)` segments instead of the
  nested-optional regex. Move all `/projects…` handling + `/agents` here.
- **Batch route = thin adapter:** validate body → fetch issue details **in
  parallel** (`Promise.all` of `github.getIssueDetail`, per-issue try/catch) →
  `pm.createWorkspacesFromIssues(projectId, seeds, baseBranch)` (sequential git)
  → second pass: for each created workspace, `if (assign) await
  github.assignIssue(...)`, `if (startAgent) const r = startAgent(path,
  template(...)); started = r.ok; if (!r.ok) error = r.error`. Merge
  fetch-failures + creation results into `{ results }`. Surface `startAgent`'s
  error (Finding 6).

`electron/webview-server.ts`:
- Remove `handleProjectRequest`, `startAgent`, and the inline `/projects` +
  `/agents` branches. Add `private get controlDeps()` returning
  `{ projectManager: this.projectManager, githubManager: this.githubManager }`.
  In `handleRequest`, before `/webviews`:
  `if (await handleControlRequest(this.controlDeps, method, url, json, readBody)) return;`
- Keep the `projectManager`/`githubManager` constructor params and fields (still
  needed for `controlDeps`) so existing call sites/tests are unchanged.
- Confirm the file is back under 1000 lines and imports of now-unused symbols
  (`LinkedIssue`, `slugify`, `BrowserWindow`) are removed from webview-server.

Existing HTTP-level tests in `mcp-webview-server.test.ts` must stay green
untouched for `/projects`, `/issues`, `/agents`. The **batch** tests will be
retargeted in ticket 4 (they currently assert `pm.createWorktree`; the batch now
calls `pm.createWorkspacesFromIssues`).

## Files to touch
- `electron/control-server.ts` (new)
- `electron/webview-server.ts`
