---
title: Add PaneDropZone overlay component to LeafPane
status: done
priority: critical
assignee: opus
blocked_by: [1, 2]
---

# Add PaneDropZone overlay component to LeafPane

Create the drop zone overlay that appears on LeafPanes during a drag. This is the core visual and interaction component — it tracks pointer position to highlight directional zones and handles the drop action.

## Implementation

### PaneDropZone component (`src/components/PaneDropZone.tsx`)

An absolutely-positioned overlay rendered inside `LeafPane` when `usePaneDrag().drag` is non-null.

**Zone detection logic:**
- Get the pane's bounding rect
- Compute pointer position relative to pane center
- Determine the closest edge: compare `|dx|` vs `|dy|` relative to pane dimensions
  - If `|dx / width|` > `|dy / height|`: horizontal zone (left if dx < 0, right if dx > 0)
  - Otherwise: vertical zone (top if dy < 0, bottom if dy > 0)
- Map to: `{ direction: SplitDirection, position: 'first' | 'second' }`

**Zone-to-split mapping:**
| Zone | direction | position |
|------|-----------|----------|
| top | `vertical` | `first` |
| bottom | `vertical` | `second` |
| left | `horizontal` | `first` |
| right | `horizontal` | `second` |

**Visual feedback:**
- Full overlay with `pointer-events: auto` to capture events
- The active half highlights with `var(--accent)` at ~15% opacity
- A 2px line at the split position using `var(--accent)` at full opacity
- Use CSS positioning: e.g., for "left" zone, highlight `left: 0; width: 50%; top: 0; bottom: 0`

**Drop handling:**
- `onPointerUp`: read the current zone, call the appropriate store action (from ticket 4), then call `endDrag()`
- Must prevent the drop from firing on the pane that's being dragged (check `drag.paneId !== paneId`)

**Styling** — add to `PaneLayout.module.css`:
```css
.dropOverlay {
  position: absolute;
  inset: 0;
  z-index: 20;
}

.dropZoneHighlight {
  position: absolute;
  background: var(--accent);
  opacity: 0.15;
  transition: all 100ms ease;
}

.dropZoneDivider {
  position: absolute;
  background: var(--accent);
  opacity: 0.8;
  z-index: 21;
}
```

### Integration into LeafPane

In `LeafPane.tsx`:
- Import `usePaneDrag`
- When `drag` is non-null AND `drag.paneId !== paneId` (not dragging onto self), render `<PaneDropZone paneId={paneId} />`
- The overlay sits inside the `.leaf` div, absolutely positioned over the entire pane

## Files to touch
- `src/components/PaneDropZone.tsx` — New file: drop zone overlay component
- `src/components/PaneLayout.module.css` — Add drop overlay styles
- `src/components/LeafPane.tsx` — Render PaneDropZone when drag is active
