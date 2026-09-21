---
title: Thin pane routes — shared tab builders, locate(), route factory, file split
status: todo
priority: high
assignee: opus
blocked_by: [7]
---

# Thin pane routes — shared tab builders, locate(), route factory, file split

ADR-182 D8, routes half. `electron/routes/panes.ts` grew from 233 to 1037 lines.

## Shared tab builders
- Create `src/lib/layout/tabs.ts` with `createBrowserTab`, `createDiffTab`, `cloneTabWithFreshIds` and `findDiffPane(layout)`.
- `findDiffPane` must search any pane. `findDiffTab` in the route (~970) only checks a tab's root leaf, which is the drift to fix.
- Both `routes/panes.ts` and `src/store/app-store.ts` use these builders (`addBrowserTab`, `addDiffTab`, `duplicateTab`, `openOrFocusDiff`, `findDiffPane` ~751).

## `LayoutStore.locate`
- Add a public `LayoutStore.locate({ paneId } | { tabId }) → { workspacePath, entry } | null`, built on the private `stateWithPane`.
- Delete `findWorkspaceWithPane` (~148), which calls `getAll()` per request.
- Move `layoutPaneIds`/`paneIdsOf` into `src/lib/layout/workspace-layout.ts` as the one copy. Replace the copies in `app-store.ts:~913`, `layout-store.ts:~214` and `routes/panes.ts:~234`.

## Route factory
- Add one factory, `structural({ locate, parse, command, respond })`, that owns:
  - `requireLayoutStore` (13 sites)
  - the `NO_WORKSPACE_ERROR` 400s (12 sites)
  - the unknown-id 400s (9 sites)
  - `applyOrError`
- Tab routes such as `pin` and `duplicate` use it, and so do the existing `withTab` users.

## File split
Split into:
- `electron/routes/panes-structural.ts`
- `electron/routes/panes-viewport.ts` (the proxy-to-renderer routes)
- `electron/routes/pane-validators.ts`

Keep `routes/panes.ts` as a small index that concatenates the route arrays, if the router registration expects one export. Every file must be under 400 lines.

## Tests
Keep `electron/routes/panes.test.ts` green.

## Files to touch
- `electron/routes/panes.ts` → the split files, `electron/routes/panes.test.ts`, `electron/layout/layout-store.ts`
- `src/lib/layout/tabs.ts` (new), `src/lib/layout/workspace-layout.ts`, `src/store/app-store.ts`
