---
title: LayoutStore owns pane and workspace teardown
status: in-progress
priority: high
assignee: opus
blocked_by: [6]
---

# LayoutStore owns pane and workspace teardown

ADR-182 D7, which also fixes regression 4.

## Problem
- **Agent abandon, three times.** Abandoning agents on pane close is done in `routes/panes.ts` (`abandonAgentForClosedPane`, ~256), which copies `agentsAbandonForPane` in `bridge/handlers/agents.ts:197`. The renderer also calls it over IPC before `close-pane` (`app-store.ts:~1754`).
- **Missing paths.** Nothing abandons agents on `close-tab`, `close-other-tabs` or `close-panel`.
- **Workspace removal in the renderer.** `removeWorkspaceLayout` (`app-store.ts:~2031-2087`) sends one `close-panel` per panel, waiting for each, then `remove`, guarded by a module-level `removingWorkspaces` set (~981).
- **CLI never cleans up.** CLI/MCP `remove_workspace` (`routes/projects.ts:~404`) never clears the server layout.

## Change
- **Agent service.** Inject an agent service (`{ abandonForPanes(paneIds: string[]) }`, backed by the existing agents handler logic) into `LayoutStore`. Wherever the store handles `killPanes` after `apply`, call it, so every close path abandons agents.
- **`remove()`.** `LayoutStore.remove(workspacePath)` kills all the workspace's panes through the same path, then drops the state and persists.
- **Worktree removal.** The main-process `removeWorktree` path, used by both the bridge and the CLI route, calls `layoutStore.remove(path)`. Find the call site in `electron/persistence.ts` or `electron/bridge/handlers/projects.ts`.
- **Delete:**
  - `abandonAgentForClosedPane` in the route
  - the renderer's pre-close IPC call
  - the sequential `close-panel` loop in `removeWorkspaceLayout`
  - `removingWorkspaces`
- **Renderer after removal.** The renderer, on removal, only drops its local copy.

## Tests
Add tests for:
- closing a tab abandons its agents
- `remove()` kills the panes
- the CLI route removal clears the layout

## Files to touch
- `electron/layout/layout-store.ts`, `electron/bridge/handlers/agents.ts`, `electron/bridge/handlers/projects.ts` / `electron/persistence.ts` (the removeWorktree path), `electron/routes/panes.ts`, `electron/routes/projects.ts`, `electron/app-lifecycle.ts` (wiring)
- `src/store/app-store.ts`, and the tests
