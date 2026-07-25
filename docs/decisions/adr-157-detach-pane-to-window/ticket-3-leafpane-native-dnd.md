---
title: LeafPane — native DnD pane drag with tear-off
status: todo
priority: critical
assignee: opus
blocked_by: [1, 2]
---

# LeafPane — native DnD pane drag with tear-off

Replace `LeafPane`'s pointer-based status-bar drag with the **same native HTML5
DnD path tabs use** (`TabBar`'s `handleTabDragStart` / `handleTabDrag` /
`handleTabDragEnd`), so a pane can be reordered/split in-window, torn off into a
new popout window, or handed to another manor window — with one OS drag image.

Use ticket 1's store primitives (`serializePaneForDetach`,
`removeDetachedPaneLocally`) and ticket 2's helpers
(`isOutsideWindow`, `findWindowAtPoint`, `spawnBoundsFor`, `buildDragImage`).

## Behavior — mirror `TabBar` exactly, pane-scoped

Make the pane **status bar** `draggable` and wire:

- **`onDragStart`**:
  - Record grab offset (pointer minus status-bar rect) and the status bar's
    `rect.left/top` within the window (for orphan-window `setPosition`).
  - `e.dataTransfer.effectAllowed = "move"`;
    `e.dataTransfer.setData("application/x-manor-pane", paneId)`.
  - Build + set the OS drag image via `buildDragImage(paneDragImageClass, title,
    contentType, favicon)` (append off-screen, `setDragImage`, `setTimeout(...,0)`
    remove) — same recipe as `TabBar.buildTabDragImage`. Add a
    `.paneDragImage` class to `PaneLayout.module.css` matching `.tabDragImage`
    in `TabBar.module.css`.
  - `startDrag({ type: "pane", paneId, grabOffset })` so `PaneDropZone`s render.
  - Snapshot `window.electronAPI.window.getBounds()` and `.listWindows()` into
    refs for the hit-test (same as `TabBar`). Reset a `tearOffCommitted` ref.
- **`onDrag`** (spawn-on-exit tear-off, Chrome-style — copy
  `TabBar.handleTabDrag`):
  - Ignore `screenX===0 && screenY===0`. If `isOutsideWindow(...)` and NOT
    `findWindowAtPoint(...)` (over another manor window → leave to release), and
    not the sole-pane-of-a-detached-window orphan case, then commit:
    `serializePaneForDetach(paneId)` → `removeDetachedPaneLocally(paneId)` →
    `window.electronAPI.window.detachTab(payload, spawnBoundsFor(...))`. Set
    `tearOffCommitted`, clear drag state, `endDrag()`. If this window is detached
    and now empty, `window.electronAPI.window.closeSelf()`.
- **`onDragEnd`** (on-release fallback — copy `TabBar.handleTabDragEnd`):
  - If `tearOffCommitted`, reset and return.
  - `handledInApp = e.dataTransfer.dropEffect !== "none"` → if handled (a
    `PaneDropZone` / `TabBar` consumed it) just `endDrag()` and return.
  - Else if released outside this window: `findWindowAtPoint` → `transferTab`
    (fall back to `detachTab` if the transfer is rejected), or `detachTab` a new
    window. Handle the orphan-window `setPosition` case. Serialize BEFORE
    `removeDetachedPaneLocally`. Close self if a detached window emptied.

Keep the existing `startDrag`/`endDrag` from `usePaneDrag()` for drop-zone
rendering; only the *end* handling and the *visual* move to native DnD. Preserve
the 4px drag threshold feel by relying on the browser's native drag threshold
(native `draggable` already only fires `dragstart` after a real drag).

## Guards
- Do not start a pane drag from a click on a button/input inside the status bar
  (today's `target.closest("button"|"input")` check) — apply the same guard in
  `onDragStart` (return without setting data / calling preventDefault).
- The browser/diff panes host a webview/BrowserView; ensure the status bar drag
  still initiates cleanly (the status bar is a normal DOM element above the view).

## Files to touch
- `src/components/workspace-panes/LeafPane.tsx` — remove
  `handleStatusBarPointerDown` and its pointer machinery; add `draggable` +
  `onDragStart`/`onDrag`/`onDragEnd` on the status bar; add the tear-off refs
  (`tearOffCommitted`, grab offset, window position, `windowBounds`,
  `otherWindows`). Import the ticket-2 helpers and the ticket-1 store actions.
- `src/components/workspace-panes/PaneLayout/PaneLayout.module.css` — add
  `.paneDragImage` (copy `.tabDragImage` from `TabBar.module.css`).

## Notes
- Reference `TabBar.tsx` lines ~206–528 as the authoritative template; the pane
  version is the same code with tab→pane swaps and no reorder/insertion-bar/merge
  logic (panes don't live in a bar).
