---
title: Block tabs on Home at the store and drop persisted Home layouts
status: todo
priority: critical
assignee: opus
blocked_by: []
---

# Block tabs on Home at the store and drop persisted Home layouts

ADR-197 §1–§2. Make it impossible for the Home surface (`HOME_PATH`, `isHomePath` from `src/lib/home-path.ts`) to hold tabs, and migrate away existing Home layouts.

## Changes

1. `src/store/app-store.ts`
   - `getActivePanelContext` (~:672) and `getActiveLayoutContext` (~:682): return `null` when `isHomePath(state.activeWorkspacePath)`. Confirm every tab/split creator (`addTab` ~:970, `addTerminalTab` ~:986, `addBrowserTab` ~:1008, `addDiffTab` ~:1042, `duplicateTab` ~:1065, `openOrFocusDiff` ~:1114, `openDiffInNewPanel` ~:1172, `splitPane` ~:1539, `splitPaneAt` ~:1566, `reopenClosedPane` ~:2030, `splitPanel` ~:2575) goes through one of these and is a clean no-op on null; add a direct `isHomePath` guard to any that doesn't.
   - `setActiveWorkspace` (~:882–927): for Home, do not create `createEmptyLayout()` and do not restore a persisted Home layout. Home must still be selectable as the active surface (`activeWorkspacePath === HOME_PATH`) and navigation history (`selectCurrentLocation` ~:651) must keep working.
   - `receiveReattachedTab` (~:3502) and `hydrateDetachedTab` (~:3460): refuse on Home. For a cross-window drop, make sure the source window keeps the tab (check the IPC handshake in `App.tsx` ~:445–458 / `DetachedApp.tsx`; if the protocol has no refusal path, reattach into... nothing — pick the least surprising option and document it in a comment).
   - `loadPersistedLayout` (~:812–880): drop any `__home__` workspace entry; collect its pane session ids and close them via the existing pane-close teardown (the same path used when a pane is closed, so daemon sessions are killed). `flushLayoutSave` (~:3568) must never write a Home layout.
2. `electron/terminal-host/layout-persistence.ts`: on load/upsert, ignore/remove a `__home__` workspace entry (use `removeWorkspace` near ~:325). Keep `lastActiveWorkspacePath === "__home__"` valid — Home is still a restorable surface.
3. `src/App.tsx`
   - Render the Home view (`HomeEmptyState`) whenever Home is active, not only when `!hasTabs`.
   - Skip the prewarm `updatePrewarmCwd` effect (~:406–424) when Home is active.
   - `handleResumeAgent` (~:618–651): if the agent's `workspacePath` is Home, don't open a tab; show a toast (use the app's existing toast helper) like "Dashboard agents can't be resumed".
4. `src/lib/menu-handlers.ts` `orderedWorkspaceKeys` (~:125): leave Home first (it is still a surface).

## Tests
- Add/extend app-store tests: with Home active, `addTab`, `addTerminalTab`, `addBrowserTab`, `splitPane`, `reopenClosedPane` leave state unchanged; `setActiveWorkspace(HOME_PATH)` creates no `workspaceLayouts["__home__"]`; `loadPersistedLayout` with a persisted Home entry drops it.
- Update `electron/terminal-host/layout-persistence.test.ts`, `src/hooks/useNavigationHistory.test.ts` as needed.
- Run `pnpm typecheck` (or the repo's equivalent in package.json) and the affected vitest files.

## Files to touch
- `src/store/app-store.ts` — central guard, setActiveWorkspace, reattach, migration
- `electron/terminal-host/layout-persistence.ts` — drop Home entry
- `src/App.tsx` — always render Home view on Home, skip prewarm, refuse resume of Home agents
- `src/DetachedApp.tsx` — only if needed for the reattach refusal
- tests listed above
