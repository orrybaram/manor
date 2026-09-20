---
title: Viewport is per renderer — selected tab, focused pane, active panel and workspace
status: done
priority: high
assignee: opus
blocked_by: [3]
---

# Viewport is per renderer — selected tab, focused pane, active panel and workspace

ADR-179 D3. Tab set shared; selection local; persisted per renderer; a
host-kept default for renderers that have none.

## Model

- `src/lib/layout/workspace-layout.ts` — remove `Tab.focusedPaneId`,
  `Panel.selectedTabId`, `WorkspaceLayout.activePanelId` from the structural
  types. Add `src/lib/layout/viewport.ts`:
  ```ts
  export interface WorkspaceViewport {
    activePanelId: string | null;
    selectedTabIds: Record<panelId, tabId>;
    focusedPaneIds: Record<tabId, paneId>;
  }
  export function reconcileViewport(layout: WorkspaceLayout, vp: WorkspaceViewport): WorkspaceViewport
  ```
  `reconcileViewport` drops references to panels/tabs/panes that no longer
  exist and fills gaps (first tab, first pane) — called on every
  `layout.changed` so a viewport never points at nothing.
- `applyLayoutCommand` stops touching those fields (they are gone). Commands
  that today imply a selection (`new-tab` selects it; `close-tab` selects a
  neighbour) return a hint in `effects` (`selectTab?: { panelId, tabId }`,
  `focusPane?: { tabId, paneId }`) that the **sending** renderer applies to
  its own viewport; other renderers ignore it.

## Store

- New slice in `app-store.ts` (or `src/store/viewport-store.ts` if that
  reads cleaner — one store, not two, for `activeWorkspacePath`):
  `viewports: Record<workspacePath, WorkspaceViewport>`,
  `activeWorkspacePath`. The existing selectors/actions `selectTab`,
  `setFocusedPane`, `setActivePanel`, `setActiveWorkspace`, `selectNextTab`,
  `selectPrevTab`, `selectTabByGlobalIndex`, `focusNextPane`, `focusPrevPane`
  write here. Every reader of `panel.selectedTabId` / `tab.focusedPaneId` /
  `layout.activePanelId` (grep; ~24 files read `workspaceLayouts`) reads the
  viewport slice instead — add selectors `useSelectedTab(panelId)`,
  `useFocusedPane(tabId)`, `useActivePanel()` so the churn is mechanical.
- Persistence per renderer, debounced 300 ms:
  - desktop primary: `window.electronAPI.viewport.save(all)` /
    `viewport.load()` → `~/.manor/viewport.json` (new tiny
    `electron/ipc/viewport.ts`; not in the bridge table);
  - web: `localStorage` under `manor.web.viewport` via
    `window.electronAPI.platform === "web"` branch — or make `viewport.*` a
    locally-served namespace in `src/web/unavailable.ts`'s `LOCALLY_SERVED`
    backed by `localStorage`, which keeps the store code identical. Prefer the
    latter.
  - Report to the host after each change: `layout.reportViewport(ws, vp)`
    (fire-and-forget, `.catch(handleBridgeUnavailable)`).
- On boot: load own viewport; for any workspace without one, take
  `defaultViewport` from `layout.getAll()`; reconcile against the layout.

## Server

- `LayoutStore.reportViewport` stores `defaultViewport` per workspace (last
  writer) and persists it in v3; `layout.json` v3 now strips the focus fields
  from the tree on save (migration from ticket 2 already populated
  `defaultViewport`; a v3 file written by ticket 2 with the fields still in
  the tree loads fine and is rewritten clean).
- `src/store/layout-snapshot.ts` (MCP `list_panes` shape) records focus once
  at the top level already; ticket 5 builds it server-side from structure +
  the primary window's reported viewport.

## Carried over from ticket 10's report

- `LayoutStore.getAll()`/`snapshot()` currently includes `paneSessions` rows
  for panes closed within the reopen grace (no tree holds them). Filter the
  snapshot to panes present in the tree; keep the rows in memory for
  `restored`.
- `LayoutStore.remove(workspacePath)` should run that workspace's pending
  kills eagerly (a removed worktree's shells should not live 10 s inside a
  directory being deleted).

## Tests

- `viewport.test.ts` — `reconcileViewport` drops dangling ids and fills
  gaps; commands' selection hints.
- Store tests for the moved actions; persistence round-trip with a fake
  `viewport.*`; boot takes the default when no own viewport exists.
- E2E `workspace-switching.spec.ts` / `sidebar-focus.spec.ts` stay green; add
  one: relaunch the app and the previously selected tab is selected.

## Files to touch
- `src/lib/layout/workspace-layout.ts`, `commands.ts`, `viewport.ts` (+tests)
- `src/store/app-store.ts` (viewport slice, moved actions, selectors)
- every reader of the three fields under `src/components/`, `src/hooks/`, `src/lib/` — mechanical via selectors
- `electron/ipc/viewport.ts` (new), `electron/ipc/index` registration, `electron/preload.ts`, `src/electron.d.ts`
- `src/web/unavailable.ts` — `viewport.*` locally served
- `electron/layout/layout-store.ts`, `electron/terminal-host/layout-persistence.ts` — default viewport, strip on save
