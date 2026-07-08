---
title: Add list_issues, start_agent, batch_create_workspaces MCP tools
status: in-progress
priority: high
assignee: sonnet
blocked_by: [1, 2]
---

# Add `list_issues`, `start_agent`, `batch_create_workspaces` MCP tools

Extend `electron/mcp-webview-server.ts` with three tools that call the HTTP
endpoints from tickets 1–2. Follow the exact style of the existing project tools
added in ADR-110 (tool defs in the `TOOLS` array, handler cases in `handleTool`,
text summaries, reuse `httpGet`/`httpPost`).

## Tool definitions (add to `TOOLS`)

### `list_issues`
- Description: "List a project's GitHub issues (assigned to you by default)."
- Props: `projectId` (string, required), `filter` (string, `assigned`|`all`,
  optional), `state` (string, `open`|`closed`|`all`, optional),
  `limit` (number, optional). Required: `["projectId"]`.

### `start_agent`
- Description: "Launch an agent session in a workspace, optionally with an
  initial prompt. Fire-and-forget: returns once the launch is dispatched."
- Props: `projectId` (string, required), `workspacePath` (string, required),
  `prompt` (string, optional). Required: `["projectId", "workspacePath"]`.

### `batch_create_workspaces`
- Description: "Create one workspace per GitHub issue and (by default) launch an
  agent in each — fan a backlog out into parallel agent workspaces."
- Props: `projectId` (string, required), `issues` (array of numbers, required),
  `baseBranch` (string, optional), `assign` (boolean, optional — assign each
  issue to you on GitHub), `startAgent` (boolean, optional, default true),
  `promptTemplate` (string, optional — supports `{number}`, `{title}`, `{body}`).
  Required: `["projectId", "issues"]`.

## Handler cases (in `handleTool` switch)

- `list_issues`: build a querystring from `filter`/`state`/`limit`, call
  `httpGet('/projects/' + encodeURIComponent(projectId) + '/issues?' + qs)`.
  Format each issue as `#<number> <title> [<labels>]`. Empty → "No issues found."
- `start_agent`: `httpPost('/agents', { projectId, workspacePath, prompt })`.
  Return `Launched agent in <workspacePath>.` The route returns 503 → the shared
  error handling in `handleTool` surfaces it.
- `batch_create_workspaces`: `httpPost('/projects/' + id + '/workspaces/batch',
  { issues, baseBranch, assign, startAgent, promptTemplate })`. Format the
  `results` array as one line per issue:
  `#<number> → <workspacePath>` + `(agent started)` or `(failed: <error>)`.

Only include optional body keys when defined (same pattern as `create_workspace`).

## Verification
- `pnpm build` succeeds; `mcp-webview-server.js` bundles.
- The three tools appear in `ListTools`.

## Files to touch
- `electron/mcp-webview-server.ts` — 3 tool defs + 3 handler cases (reuse `httpGet`/`httpPost`)
