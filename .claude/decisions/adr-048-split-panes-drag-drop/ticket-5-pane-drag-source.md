---
title: Make pane status bar a drag source
status: done
priority: high
assignee: sonnet
blocked_by: [2, 3, 4]
---

# Make pane status bar a drag source

Enable dragging panes by their status bar to create splits in other panes. The status bar at the top of each LeafPane becomes a drag handle.

## Implementation

In `LeafPane.tsx`:

1. **Add pointer event handlers to the pane status bar:**
   - `onPointerDown`: record start position, set pointer capture
   - On `pointermove`: if moved > 4px threshold, call `startDrag({ type: 'pane', paneId })`
   - On `pointerup`: if drag was active, call `endDrag()`. If not active (just a click), do nothing special.

2. **Visual feedback during drag:**
   - When this pane is the drag source (`drag?.type === 'pane' && drag.paneId === paneId`), add a CSS class that reduces opacity to 0.5
   - Add cursor: `grabbing` on the status bar during active drag
   - Add cursor: `grab` on the status bar at rest (to hint it's draggable)

3. **Prevent self-drop:**
   - The PaneDropZone (from ticket 3) should already check `drag.paneId !== paneId` to prevent dropping on self

4. **Status bar interaction compatibility:**
   - The split and close buttons already use `e.stopPropagation()` on click, so they won't interfere with drag
   - Only start drag on the status bar div itself, not on buttons within it

Add to `PaneLayout.module.css`:
```css
.paneStatusBar {
  cursor: grab;
}

.paneStatusBarDragging {
  cursor: grabbing;
  opacity: 0.5;
}
```

## Files to touch
- `src/components/LeafPane.tsx` — Add drag source behavior to status bar
- `src/components/PaneLayout.module.css` — Add drag cursor and opacity styles
