---
title: Store serialize / remove / hydrate primitives
status: in-progress
priority: critical
assignee: opus
blocked_by: [2]
---

# Store serialize / remove / hydrate primitives

Add the three Zustand actions that move a tab's state across windows. These are
pure store operations plus PTY/webview detach calls — no window creation here.

## Requirements

In `src/store/app-store.ts` (add to the `AppState` interface and implementation):

1. **`serializeTabForDetach(tabId: string): DetachedTabPayload`**
   - Find the tab across `workspaceLayouts` panels; collect its pane ids via
     `allPaneIds(tab.rootNode)` (`src/store/pane-tree.ts`).
   - Build `DetachedTabPayload` (ticket 2 shape): copy the tab's
     `{ id, title, rootNode, focusedPaneId }` and, for each `paneId`, copy every
     per-pane side-map entry that exists (`paneCwd`, `paneTitle`,
     `paneContentType`, `paneUrl`, `paneFavicon`, `paneAgentStatus`,
     `paneAudioPlaying`, `paneAudioMuted`, `panePickedElement` — see the side-map
     list around `app-store.ts:192-201`). Include `sourceWorkspacePath =
     activeWorkspacePath`.
   - Must return structured-clone-safe plain data.

2. **`removeDetachedTabLocally(tabId: string)`**
   - Remove the tab from its panel and, if the panel becomes empty, collapse it
     the same way `closeTab` collapses empty panels — **reuse existing panel
     cleanup logic**; do not duplicate it divergently.
   - Crucially, do **not** kill panes. For each pane in the tab:
     - terminal (`paneContentType === "terminal"`): call
       `window.electronAPI.pty.detach(paneId)` (NOT `pty.close`).
     - browser (`"browser"`): call `window.electronAPI.webview.unregister(paneId)`.
     - diff: no backend teardown needed.
   - Delete the tab's entries from all per-pane side-maps.
   - This differs from `closeTab`/`requestCloseTab`, which terminate sessions.

3. **`hydrateDetachedTab(payload: DetachedTabPayload)`**
   - Intended to run in a **fresh detached-window store**. Build a minimal layout:
     one workspace layout entry, one `Panel` containing the single `payload.tab`,
     `selectedTabId = tab.id`. Use `payload.sourceWorkspacePath` as the layout
     key (or a synthetic key — see notes).
   - Repopulate every per-pane side-map from `payload.paneState` so the normal
     render path (`PaneLayout`/`LeafPane`) re-attaches PTYs by `paneId` and
     re-mounts webviews at their saved `paneUrl`.
   - Do **not** mint new `paneId`s — the ids must match so terminals re-attach to
     the same daemon sessions.

## Files to touch
- `src/store/app-store.ts` — add the three actions to `AppState` + implementation.
- `src/store/detach-types.ts` — import/confirm `DetachedTabPayload` (from ticket 2).
- `src/store/pane-tree.ts` — reuse `allPaneIds` (no change expected).

## Notes
- `hydrateDetachedTab` runs in a different renderer than `serializeTabForDetach`;
  they communicate only via the IPC payload (ticket 2), never shared memory.
- Keep the detached store's `activeWorkspacePath` set so pane render logic that
  reads it still works; the layout-save subscription is disabled separately in
  ticket 4, so this hydration won't trigger a persistence collision.
