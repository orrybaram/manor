---
title: MCP and CLI layout routes hit the server, not a window
status: in-progress
priority: high
assignee: sonnet
blocked_by: [4]
---

# MCP and CLI layout routes hit the server, not a window

ADR-179 D5. `manor split-pane` works with the desktop window closed.

## Routes

`electron/routes/panes.ts` — split each route into one of two kinds:

- **Structural** → `deps.layoutStore.apply(workspacePath, command,
  { kind: "route", id: "cli" })` directly: `POST /panes/split`,
  `POST /panes/reopen`, `POST /panes/:paneId/title`, `POST /panes/:paneId/move`,
  `POST /panes/:paneId/extract`, `DELETE /panes/:paneId`, `POST /tabs`
  (new-tab), `POST /tabs/reorder`, `POST /tabs/diff`, `POST /tabs/:tabId/close`,
  `/close-others`, `/close-to-right`, `/pin`, `/duplicate`. Workspace
  resolution: `body.workspacePath` if given, else the primary window's last
  reported active workspace (`layoutStore` knows it from viewport reports;
  expose `primaryActiveWorkspace()`), else 400 with a message naming the
  option. Ids the command needs (`newPaneId`, `newTabId`) are generated in the
  route. Reply shape unchanged from what `app-commands.ts` returned so
  `electron/mcp/tools-panes.ts` and the CLI do not change.
- **Viewport** → unchanged `proxyToRenderer` to the primary:
  `POST /panes/focus-next`, `/focus-prev`, `/panes/:paneId/focus`,
  `POST /workspaces/active` (set-active-workspace), `POST /tabs/next`,
  `/prev`, `/tabs/:tabId/select`.
- `GET /panes` — build `LayoutSnapshot` on the server from
  `layoutStore.get(ws)` plus the primary's reported viewport; when no window
  has reported, focus fields are null and the snapshot says so. Move
  `buildLayoutSnapshot` from `src/store/layout-snapshot.ts` into
  `src/lib/layout/snapshot.ts` (pure) so both sides import it.
- `POST /agents` (`start-agent`, `routes/agents.ts:302`) creates a tab and
  launches: the tab creation becomes a `new-tab` command through the store;
  the launch part stays as it is (it already goes through the renderer for the
  prompt injection — leave that).

## Carried over from ticket 4's report

- `LayoutStore.primaryViewport()` is currently "the most recent window
  report", which is what `GET /panes` has to build on until ticket 6 gives
  windows claims. Use it, name the limitation in a comment, and leave a
  `// ticket 6` marker where the primary's id should be preferred.
- `LayoutStore.lastActiveWorkspacePath` / `layout.getLastActive()` is now
  only a boot fallback for a renderer with no `viewport.json`. Keep it for
  the routes' "no `workspacePath` given" default; do not widen it.

## Renderer

`src/lib/app-commands.ts` — delete the structural command handlers; keep the
viewport ones and `start-agent`/`open-diff`-style ones that still need a
window. `src/lib/__tests__/app-commands.test.ts` follows.

## Tests

- `electron/routes/__tests__/panes.test.ts` (new or extend the existing
  router tests) — each structural route applies the expected command with a
  fake `layoutStore` and needs no renderer; viewport routes still proxy;
  `GET /panes` renders a snapshot without a window.
- MCP: `electron/mcp/` tests for `list_panes`/`split_pane` unchanged and green.

## Files to touch
- `electron/routes/panes.ts`, `electron/routes/agents.ts` — structural → store
- `electron/routes/types.ts` — `ControlDeps.layoutStore` (added in ticket 2; use it)
- `src/lib/layout/snapshot.ts` — moved pure snapshot builder; `src/store/layout-snapshot.ts` shim or delete
- `electron/mcp/tools-panes.ts` — import path only
- `src/lib/app-commands.ts` + test — shrink to viewport commands
- route tests as listed
