---
title: Cover the Linear issue routes with integration tests
status: done
priority: high
assignee: sonnet
blocked_by: [2, 3]
---

# Cover the Linear issue routes with integration tests

Extend the existing MCP integration suite. Follow its established pattern (documented in
its header, lines 5-14): the MCP server module cannot be imported directly, so tests mock
`electron`, start a real `WebviewServer` on a real port, and exercise the HTTP endpoints
via `fetch`.

The existing `GET /projects/:id/issues` block (~line 512) stubs `githubManager` as a plain
object with `getMyIssues` / `getAllIssues` / `getIssueDetail` / `assignIssue` `vi.fn()`
spies, passed into the `WebviewServer` constructor. Do the same for `linearManager`:

```ts
const linearManager = {
  isConnected: vi.fn(() => true),
  getMyIssues: vi.fn(async () => [...]),
  getAllIssues: vi.fn(async () => [...]),
  getIssueDetail: vi.fn(async () => ({...})),
};
```

The `WebviewServer` constructor now takes it as a fourth arg (ticket 2).

## Cases to cover

`GET /projects/:id/issues?source=linear`

- Passes `project.linearAssociations.map(a => a.teamId)` as `teamIds`, and
  `{ stateTypes: ["triage","backlog","unstarted","started"], limit }` for the default
  `state=open`. Assert on the spy's call args, not just the response.
- `filter=all` → calls `getAllIssues`, not `getMyIssues`.
- `state=closed` → `stateTypes: ["completed","canceled"]`.
- Response normalization: a `LinearIssue` fixture comes back as
  `{ source: "linear", id: "ENG-1", ref: "ENG-1", state: <state.name>, labels: ["bug"] }`.
- 503 when `linearManager` is absent, and 503 when `isConnected()` returns `false` — both
  with the "not connected" message.
- 400 when the project's `linearAssociations` is `[]` — the "no Linear team" message. This
  is the one that must **not** be a 503; it is a config problem, not a missing capability.
- 502 when `getMyIssues` rejects (expired token). Assert the server responds rather than
  crashing.

`GET /projects/:id/issues?source=github` — assert the existing behavior is unchanged and
now returns the normalized shape (`ref: "#42"`, `labels: ["bug"]`).

`GET /projects/:id/issues?source=bogus` — 400.

`GET /projects/:id/issues/:issueRef`

- `source=github` with `"42"` → `getIssueDetail(project.path, 42)` (number, not string).
- `source=github` with `"ENG-1"` → 400, and `getIssueDetail` is never called.
- `source=linear` with `"ENG-1"` → `linearManager.getIssueDetail("ENG-1")`, response has
  `body` populated from the fixture's `description`.

`POST /projects/:id/workspaces/batch` with `source=linear` → 400.

## Files to touch

- `electron/__tests__/mcp-webview-server.test.ts` — add a `linearManager` stub to the
  existing agent-orchestration `describe` block's setup, add the cases above. Add a new
  `describe("GET /projects/:id/issues/:issueRef")` sibling to the existing issues block.

Note ticket 1 already unit-tests the normalizers in `electron/issue-sources.test.ts`. Do
not duplicate that coverage here — these tests are about routing, dep-guards, and the
arguments actually handed to each manager.
