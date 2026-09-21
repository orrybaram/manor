---
title: Fix pane titles, prompt launch and follower font regressions
status: todo
priority: critical
assignee: sonnet
blocked_by: []
---

# Fix pane titles, prompt launch and follower font regressions

ADR-182 D1, plus regressions 5 and 6 from its context.

## 1. Pane titles (D1)
- **Add the store method.** Add `LayoutStore.setPaneTitle(paneId, title: string | null)` in `electron/layout/layout-store.ts`. It should:
  - find the owning workspace (reuse the private `stateWithPane`)
  - update `paneSessions[paneId].lastTitle`
  - `schedulePersist()`
  - publish a renderer broadcast event such as `layout.paneTitle` `{ paneId, title }`. Reuse the existing publish path that `layout.changed` uses.
- **Return value.** Return `false` if the pane is unknown. Do not call `ensureState` for unknown workspaces.
- **Route.** `POST /panes/:paneId/title` (`electron/routes/panes.ts:~471`) calls `store.setPaneTitle` directly and returns 400 for an unknown pane.
- **Renderer.** Subscribe to the new event and call `useAppStore.getState().setPaneTitleFromStream(paneId, title)`. Do this where the other layout subscriptions live (search `layout.onChanged` or equivalent in `src/store/app-store.ts` or its bootstrapping).
- **Store action.** `setPaneTitle` in `app-store.ts:~1855` sends the title to the server through a new bridge method `layout.setPaneTitle(paneId, title)`, added to the handler table and to `electron.d.ts`. It no longer sends a `set-pane-title` command. Delete the unused `clearPaneTitle`.
- **Delete the old path:**
  - the `set-pane-title` variant from `LayoutCommand` (`src/lib/layout/commands.ts:177`)
  - its reducer case (`:438`)
  - the `applyNow` special case
  - its `COMMAND_TYPES` entry (`layout-store.ts:169`)
- **Tests.** Update the tests, and add one test proving the route broadcasts.

## 2. Prompt launch (regression 5)
- `handleNewAgentWithPrompt` in `src/App.tsx:~623` builds `` `${activeWorkspaceCommand} "${escaped}"` `` by hand. Replace the body with `launchAgentInWorkspace(activeWorkspacePath, { prompt })` from `src/lib/agent-prompt-launch.ts`, matching its real signature.
- Then check whether `src/lib/home.ts` still needs to re-export `escapeShellDoubleQuoted`. If not, remove the re-export.

## 3. Follower font (regression 6)
- **The bug.** In `src/hooks/useTerminalResize.ts`, a follower shrinks `term.options.fontSize` (~:271) and never restores it. It also captures `configuredFontSizeRef` once, so a later font-size preference change is missed.
- **Split the hook.** Split owner and follower sizing into two hooks, `useOwnerFit` and `useFollowerFit`. Both are always called and each takes an `enabled` flag.
- **Restore the font.** The follower's effect cleanup restores the configured font size from the live preference.
- **One grid setter.** In `src/hooks/useTerminalLifecycle.ts` (~:124-163), collapse the two copies of "keep the previous value if the grid is unchanged" into one `setFollowerGrid(cols, rows | null)`.
- **Test.** Add a unit test proving the font is restored when a follower becomes the owner.

## Files to touch
- `electron/layout/layout-store.ts`, `electron/routes/panes.ts`, `src/lib/layout/commands.ts`, `electron/bridge/handlers.ts` + `electron/bridge/handlers/layout.ts`, `src/electron.d.ts`, `src/store/app-store.ts`, `src/store/__tests__/fake-layout-server.ts`
- `src/App.tsx`, `src/lib/home.ts`
- `src/hooks/useTerminalResize.ts`, `src/hooks/useTerminalLifecycle.ts`, and their tests
