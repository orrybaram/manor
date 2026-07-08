---
title: Layout snapshot — one home, one truth, no flattenPaneTree
status: todo
priority: critical
assignee: opus
blocked_by: []
---

# Layout snapshot — one home, one truth, no flattenPaneTree

Fixes correctness bug #1 (`list_panes` marks multiple panes `[focused]` and
multiple tabs `[active]`) and makes structural deletion #15.

## The bug

`getLayoutSnapshot` (`src/store/app-store.ts:2551`) loops every panel and sets
`active: tab.id === panel.selectedTabId` **per panel**; `flattenPaneTree` sets
`focused: node.paneId === focusedPaneId` where `focusedPaneId` is
**`tab.focusedPaneId`, per tab**. So a single-panel workspace with three tabs
emits three panes with `focused: true`, and a two-panel workspace emits two tabs
with `active: true`. `formatLayoutSnapshot` faithfully prints `[focused]` three
times.

## What to do

### 1. Create `src/store/layout-snapshot.ts`

Move `PaneSnapshot` and `TabSnapshot` out of `src/store/pane-tree.ts` (lines
~339-353) and `LayoutSnapshot` out of `src/store/app-store.ts` (line ~191).
Drop the per-item `active` and `focused` booleans. New shape:

```ts
export interface PaneSnapshot {
  paneId: string;
  contentType: "terminal" | "browser" | "diff";
  url?: string;
}
export interface TabSnapshot {
  tabId: string;
  title: string;
  focusedPaneId: string;
  panes: PaneSnapshot[];
}
export interface LayoutSnapshot {
  workspacePath: string;
  /** The one active tab, across every panel. */
  activeTabId: string | null;
  /** The one focused pane, in the active panel's active tab. */
  focusedPaneId: string | null;
  tabs: TabSnapshot[];
}
```

Export a **free selector**, not a store action (ADR-149 §107 asked for this):

```ts
export function layoutSnapshot(state: AppState): LayoutSnapshot | null
```

`activeTabId` / `focusedPaneId` come from
`layout.panels[layout.activePanelId]` — its `selectedTabId`, and that tab's
`focusedPaneId`. Everything else is a plain listing.

Keep listing tabs from **all** panels (ticket 2 makes every listed paneId
actionable). `TabSnapshot.focusedPaneId` stays: it is per-tab state and is not a
claim about global focus.

### 2. Delete `flattenPaneTree`

`src/store/pane-tree.ts:365-386` re-derives the depth-first left-to-right walk
that `allPaneIds` (line 21) already does, takes four positional params, widens
`paneContentType` to `Record<string, string>`, and then casts it back to the
union the store already declares at `app-store.ts:202`.

Build panes inside the selector instead:

```ts
panes: allPaneIds(tab.rootNode).map((paneId) => {
  const contentType = state.paneContentType[paneId] ?? "terminal";
  const url = state.paneUrl[paneId];
  return {
    paneId,
    contentType,
    ...(contentType === "browser" && url !== undefined && { url }),
  };
}),
```

No cast. Delete `flattenPaneTree`, its export, and its tests in
`src/store/pane-tree.test.ts`.

### 3. Remove `getLayoutSnapshot` from the store

Delete the `getLayoutSnapshot` action, its `AppState` member (~line 381), and the
`LayoutSnapshot` interface at `app-store.ts:191`. Update `src/lib/app-commands.ts`'s
`listPanes` to call `layoutSnapshot(useAppStore.getState())`.

### 4. Point the MCP side at the same types

`electron/mcp/tools-panes.ts:11-29` re-declares all three interfaces under a
`// mirrors src/store/pane-tree.ts` comment. Replace with:

```ts
import type { LayoutSnapshot } from "../../src/store/layout-snapshot";
```

`electron/github.ts:7` already imports a type from `src/`, and a type-only import
is erased at compile time, so the MCP process stays Electron-free. Verify no
runtime import of `src/store/*` is introduced — `import type`, not `import`.

Note: this only became clean in `efb2667`. `tsconfig.electron.json` previously
set `rootDir: "electron"`, which made *any* cross-boundary import a TS6059 error
(three already existed, including the `github.ts` line above). That config is
lint-only — `vite-plugin-electron` bundles the main process and never reads it —
so `rootDir`/`outDir` were dropped and `noEmit` set. Electron typecheck baseline
is now **28** pre-existing errors, zero TS6059. Add none.

### 5. Update `formatLayoutSnapshot`

`electron/mcp/tools-panes.ts:33-50` must now mark `[active]` when
`tab.tabId === snapshot.activeTabId` and `[focused]` when
`pane.paneId === snapshot.focusedPaneId`. Exactly one of each can print.

## Files to touch
- `src/store/layout-snapshot.ts` — new: the three types + `layoutSnapshot(state)` selector
- `src/store/pane-tree.ts` — delete `flattenPaneTree`, `PaneSnapshot`, `TabSnapshot`
- `src/store/pane-tree.test.ts` — delete the `flattenPaneTree` block
- `src/store/app-store.ts` — delete `getLayoutSnapshot`, its `AppState` member, `LayoutSnapshot`
- `src/lib/app-commands.ts` — `listPanes` calls the free selector
- `electron/mcp/tools-panes.ts` — import the shared type; fix `formatLayoutSnapshot`

## Verify
`pnpm typecheck` clean. A workspace with 3 tabs in 1 panel must produce exactly
one `[focused]` line and one `[active]` line from `formatLayoutSnapshot`.
