---
title: Tests and docs for agent-orchestration tools
status: done
priority: medium
assignee: haiku
blocked_by: [1, 2, 3]
---

# Tests and docs for agent-orchestration tools

## Tests

Extend `electron/__tests__/mcp-webview-server.test.ts` (it already spins up a
real `WebviewServer` with a mock `ProjectManager` in the
"project/workspace routes" describe block). Add a describe block for the new
routes using a mock `GitHubManager` and a spy for `startAgent`:

- **`GET /projects/:id/issues`** — mock `github.getMyIssues` / `getAllIssues`
  and assert the `filter=all` vs default (`assigned`) branch calls the right one
  with `project.path`, `limit`, `state`.
- **`POST /agents`** — construct the server, stub `BrowserWindow.getAllWindows`
  (vitest `electron` mock) to return one window with a `webContents.send` spy;
  assert the route sends `app-command` with `{ cmd: "start-agent",
  workspacePath, prompt }` and returns `{ ok: true }`. Assert the empty-window
  case returns 503.
- **`POST /projects/:id/workspaces/batch`** — mock `getIssueDetail`,
  `createWorktree`, `assignIssue`; pass two issue numbers; assert `createWorktree`
  is called once per issue with a `linkedIssue` shaped `{ id, identifier, title,
  url }`, that `assign` triggers `assignIssue`, and that the response `results`
  has one entry per issue. Include a case where one issue throws and assert the
  batch still returns the other (partial success).

Extend the vitest `electron` mock at the top of the file so `BrowserWindow` is
available (add `BrowserWindow: { getAllWindows: vi.fn() }`).

## Docs

- `docs/AGENT-TASK-SYSTEM.md` §10.4 — add the three new tools to the `manor` MCP
  server description and note ADR-144.
- `README.md` — if it documents MCP tools, add a short "Agent orchestration"
  line (list_issues / start_agent / batch_create_workspaces).

## Verification
- `pnpm test` green for the MCP test file.
- `pnpm build` succeeds.

## Files to touch
- `electron/__tests__/mcp-webview-server.test.ts` — new describe block + `BrowserWindow` mock
- `docs/AGENT-TASK-SYSTEM.md` — document new tools
- `README.md` — optional tool listing
