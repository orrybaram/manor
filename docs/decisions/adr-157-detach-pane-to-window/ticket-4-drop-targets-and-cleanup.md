---
title: Drop targets accept native pane drops + retire pointer path
status: done
priority: high
assignee: opus
blocked_by: [3]
---

# Drop targets accept native pane drops + retire pointer path

Teach the existing drop targets to accept the native `application/x-manor-pane`
drag introduced in ticket 3, and remove the now-dead pointer-based pane drag
model (DOM ghost + cursor tracking + pointerup extraction).

## Changes

### `PaneDropZone` — native pane branch
- In `handleDragOver`: accept `application/x-manor-pane` in addition to
  `application/x-manor-tab` (compute + show the same split zone).
- In `handleDrop`: if the payload is a pane
  (`e.dataTransfer.getData("application/x-manor-pane")`), call
  `movePaneToTarget(paneId, targetPaneId, zone.direction, zone.position)`;
  keep the existing tab branch (`moveTabToPane`). `endDrag()` after.
- Remove the pointer-based pane path: `onPointerMove` / `onPointerUp` /
  `onPointerLeave` handlers and the `movePaneToTarget` call inside `handlePointerUp`
  (that store action is now driven from the native drop). Keep the overlay
  element and its `zone` highlight rendering.

### `TabBar` — native pane drop → extract to tab
- Replace `handlePanePointerUp` (`onPointerUp` on the bar) with a native pane
  branch inside `handleBarDrop` (and accept the pane type in `handleBarDragOver`
  so `preventDefault` marks the bar a valid target): a dropped
  `application/x-manor-pane` → `extractPaneToTab(paneId, panelId)` then
  `endDrag()`. Remove the `onPointerUp={isDragActive ? handlePanePointerUp : ...}`
  wiring and the now-unused `extractPaneToTab`-via-pointer code.
- Leave all tab drag logic untouched.

### `PaneDragContext` — drop the DOM ghost + cursor tracking
- Remove the `cursorPos` state, the global `pointermove` effect, and the
  `{drag?.type === "pane" && <PaneDragGhost .../>}` render. The OS drag image
  (ticket 3) is now the only pane drag visual, matching tabs.
- Keep the `drag` state and `startDrag`/`endDrag` (drop zones still key off
  `drag.type === "pane"`). Keep the `DragPayload` union unchanged.

### Delete `PaneDragGhost`
- Remove `src/components/workspace-panes/PaneDragGhost.tsx` and its import in
  `PaneDragContext.tsx`. Grep for any other references first.

## Files to touch
- `src/components/workspace-panes/PaneDropZone.tsx` — add native pane
  dragover/drop branch; remove pointer-based pane handlers.
- `src/components/tabbar/TabBar/TabBar.tsx` — native pane drop in `handleBarDrop`
  / `handleBarDragOver`; remove `handlePanePointerUp` + its `onPointerUp` wiring.
- `src/components/workspace-panes/PaneDragContext.tsx` — remove cursor tracking +
  `PaneDragGhost` render.
- `src/components/workspace-panes/PaneDragGhost.tsx` — DELETE.

## Notes
- After this ticket there is exactly one pane drag model (native DnD). Verify no
  remaining references to `PaneDragGhost` or the pane `pointerup` path (grep).
- A pane dropped on another window (via ticket 3's `transferTab`) arrives as a
  tab there — intended, and needs no receive-side change.
