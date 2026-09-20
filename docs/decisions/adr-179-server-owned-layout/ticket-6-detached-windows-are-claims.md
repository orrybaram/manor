---
title: A detached window is a claim on one tab of the shared layout
status: in-progress
priority: high
assignee: opus
blocked_by: [4]
---

# A detached window is a claim on one tab of the shared layout

ADR-179 D4. Replaces ADR-156/157's hand-off. The tab never leaves the
workspace; a desktop window's viewport says "I show this one tab", the primary
hides it, a browser sees everything.

## Server

- `WorkspaceViewport` gains `claim?: tabId` (only ever set by a non-primary
  desktop window). `LayoutStore` keeps `claims: Map<windowId, { workspacePath,
  tabId }>` from `reportViewport` (rendererId = `webContents.id` for windows;
  bridge sockets never set `claim` — reject it in the handler). Include
  `claims: Array<{ windowId, tabId }>` in every `layout.changed` for that
  workspace, and broadcast on claim change even when the tree did not change.
- Release on window `closed` (`app-lifecycle.ts`'s `trackRendererWindow`,
  next to `releaseViewer`). A claim on a tab that leaves the tree is dropped.
  A second window claiming the same tab wins; the first is sent a
  `layout.changed` whose `claims` no longer include it and closes itself
  (today's behaviour when a tab is torn off twice).
- `electron/ipc/window.ts` — `window:detachTab(tabId, bounds)` creates the
  window with `--manor-detached=<windowId>` **and** `--manor-claim=<workspacePath>:<tabId>`;
  `window:transferTab`, `window:reattachTab`, `window:reattachPane`,
  `window:getDetachPayload` are deleted. `extract-pane-to-tab` + `detachTab`
  covers "detach pane".

## Renderer

- `src/main.tsx` — the detached branch renders `App` with
  `initialViewport = { claim }` instead of `DetachedApp`. Delete
  `src/DetachedApp.tsx`, `src/store/detach-types.ts`, `src/lib/window-handoff.ts`
  (+ test), `removeDetachedTabLocally`, `removeDetachedPaneLocally`.
- `App`/`PanelLayout` — with a claim, render only that tab's pane tree (no
  sidebar, no tab bar, as `DetachedApp` did); without a claim (primary), the
  tab bar hides tabs in `claims` and the panel's selected tab skips them
  (`reconcileViewport` gets the claim set). A browser renderer ignores
  `claims` entirely.
- `TabBar`, `TabButton`, `LeafPane`, `PaneWindowMenuItems`, `menu-handlers`,
  `menu-commands` — "Move to New Window" / tear-off drag call
  `window:detachTab`; "Move to main window" (in the detached window) clears
  the claim by closing itself; drag from a detached window back into the
  primary = close + the tab is already there.
- The detached window's own viewport (focused pane within the tab) persists
  nowhere — it is ephemeral, as today's detached windows are.

## Tests

- `layout-store` tests — claim set/release/steal, release on window death,
  broadcast on claim change.
- Renderer: tab bar hides claimed tabs; a claimed window renders one tab;
  a browser renders all tabs (pure selector tests).
- E2E: extend `duplicate-tab.spec.ts` or add `detach.spec.ts` — detach a tab,
  assert it leaves the primary's tab bar, the popup shows it, `GET /panes`
  still lists it, close the popup, it is back. If `tests/e2e/helpers/window.ts`
  has detach helpers, reuse them.

## Files to touch
- `electron/layout/layout-store.ts`, `electron/app-lifecycle.ts`, `electron/ipc/window.ts`, `electron/window.ts`
- `src/main.tsx`, `src/App.tsx`, `src/components/panels/PanelLayout.tsx`
- `src/components/tabbar/TabBar/TabBar.tsx`, `TabButton.tsx`, `src/components/workspace-panes/LeafPane.tsx`, `PaneWindowMenuItems.tsx`, `src/lib/menu-handlers.ts`, `src/lib/menu-commands.ts`
- deletions: `src/DetachedApp.tsx`, `src/store/detach-types.ts`, `src/lib/window-handoff.ts` (+test), store actions
- `electron/preload.ts`, `src/electron.d.ts` — `window.*` surface
- tests as listed
