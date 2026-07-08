---
title: Cover the /context route with integration tests
status: todo
priority: high
assignee: sonnet
blocked_by: [2, 3]
---

# Cover the `/context` route with integration tests

Ticket 1 already unit-tests the pure resolver in `electron/pane-context.test.ts`. Do not
duplicate that. These tests are about **routing, the resolution ladder, dep-guards, and the
`sources` computation**.

Extend `electron/__tests__/mcp-webview-server.test.ts`, following its established pattern
(header comment, lines 5-14): the MCP server module cannot be imported directly, so tests
mock `electron`, start a **real `WebviewServer` on a real port**, and drive the HTTP
endpoints via `fetch`. ADR-148 added `githubManager` / `linearManager` stubs to the agent
orchestration `describe` block — add a `layoutPersistence` stub the same way:

```ts
const layoutPersistence = { load: vi.fn(() => LAYOUT_FIXTURE) };
```

It is the newest optional `WebviewServer` constructor param (ticket 2).

## Fixtures

Build a `PersistedLayout` v2 fixture with a pane in a **non-first** workspace, tab, and
panel — a fixture where a naive "first hit" implementation would pass is worthless. Shapes:

- `PersistedLayout { version: 2, workspaces: PersistedWorkspace[] }`
- `PersistedWorkspace { workspacePath, panelTree, panels: Record<string, PersistedPanel>, activePanelId }`
- `PersistedPanel { id, tabs: PersistedTab[], selectedTabId, pinnedTabIds }`
- `PersistedTab { id, title, rootNode, focusedPaneId, paneSessions: Record<paneId, PersistedPaneSession> }`

The project fixture needs a main workspace **and** a worktree nested beneath it (e.g.
`/repo` and `/repo/.worktrees/feat`) so the longest-prefix behavior is actually exercised
end-to-end through the route.

## Cases

`GET /context`

- **paneId rung** — `?paneId=<pane in the fixture>` → 200, correct `projectId` /
  `workspacePath`, `resolvedBy: "paneId"`. Assert `layoutPersistence.load` was called.
- **cwd rung** — `?cwd=/repo/.worktrees/feat/src` with **no** `paneId` → 200,
  `resolvedBy: "cwd"`, and the matched workspace is the **worktree**, not the main
  workspace whose path is also a prefix.
- **paneId wins over cwd** — pass both, pointing at different workspaces; assert the
  paneId's workspace is returned.
- **paneId misses, falls through to cwd** — a paneId absent from the layout plus a valid
  `cwd` → 200, `resolvedBy: "cwd"`. This is the debounce-lag case the ADR calls out; it
  must not 404.
- **corrupt layout falls through** — `load` throws (or returns `null`) and a valid `cwd` is
  given → 200, `resolvedBy: "cwd"`. Must not 500.
- **no layoutPersistence at all** (constructor arg omitted) + valid `cwd` → 200.
- **404** — neither param resolves → 404, body has `error` and a `candidates` array whose
  entries carry `projectId`, `name`, `path`. Assert the candidates are non-empty.
- **405** on `POST /context`.
- **503** when the `WebviewServer` has no `projectManager`.

`sources` computation — drive each through the route, not by calling a helper:

- github manager present, linear connected, project has `linearAssociations` →
  `["github", "linear"]`.
- linear connected but `linearAssociations: []` → `["github"]`. **This is the important
  one** — a connected account with no team associated must not be advertised.
- `linearManager.isConnected()` returns `false`, associations present → `["github"]`.
- no `githubManager`, linear fully configured → `["linear"]`.
- neither → `[]`.

Read the **actual** error strings and field names out of `electron/control-server.ts`
rather than trusting this ticket's paraphrase. Assert against what the code really returns.

## If a test fails

Fix the implementation only when the fix is small and clearly correct. Otherwise report it
as a defect. **Do not weaken a test to make it pass** — in particular, if longest-prefix
matching or the paneId-beats-cwd precedence is wrong, that is a real bug in ticket 1 or 2,
not a bad test.

## Files to touch

- `electron/__tests__/mcp-webview-server.test.ts` — a `layoutPersistence` stub in the
  existing setup, and a new `describe("GET /context")` block.

## Checks

- `pnpm exec vitest run electron/__tests__/mcp-webview-server.test.ts` — report exact
  pass/fail counts.
- `pnpm exec tsc --noEmit -p tsconfig.electron.json` — ~31 pre-existing errors; add none.
- `pnpm exec eslint electron/__tests__/mcp-webview-server.test.ts`

## Commit

Stage only that one file, by name. ADR-149 may be editing this repo concurrently; never
`git add -A`.

  git commit -m "test(adr-150): Cover the /context route with integration tests"

No `Co-Authored-By` trailer.
