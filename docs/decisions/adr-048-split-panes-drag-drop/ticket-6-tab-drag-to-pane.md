---
title: Enable tab drag into panes for split creation
status: done
priority: high
assignee: opus
blocked_by: [2, 3, 4]
---

# Enable tab drag into panes for split creation

Extend the existing tab drag system so that when a tab is dragged out of the tab bar area and over a pane, it triggers the pane drop zones and creates a split on drop.

## Implementation

This is the most complex integration ticket because it bridges the tab bar's existing pointer-capture drag system with the new pane drop zones.

### Approach

The tab bar currently uses `setPointerCapture` which routes all pointer events to the captured element. This means pane drop zones won't receive pointer events directly. Two options:

**Option A (recommended): Release capture when leaving tab bar bounds**
- In the tab bar's `onMove` handler, check if the pointer is below the tab bar's bottom edge
- If so, release pointer capture and set the drag context: `startDrag({ type: 'tab', sessionId })`
- The PaneDropZone overlay's pointer events then naturally take over
- On `pointerup` anywhere (including pane drop zones), clean up the tab drag state

**Option B: Mirror events from tab bar to pane areas**
- More complex, not recommended

### Changes to TabBar.tsx

1. In the `onMove` handler, after the existing drag logic:
   ```typescript
   // Check if pointer has left the tab bar area
   const tabBarRect = tabBarRef.current?.getBoundingClientRect();
   if (tabBarRect && ev.clientY > tabBarRect.bottom + 20) {
     // Release pointer capture so pane drop zones can receive events
     tabEl.releasePointerCapture(e.pointerId);
     startDrag({ type: 'tab', sessionId: sessions[idx].id });
     // Set a flag so the cleanup handler knows this was a pane-drop handoff
     handedOffToPaneDrop.current = true;
   }
   ```

2. In the `onUp` handler, check if this was a pane-drop handoff:
   ```typescript
   if (handedOffToPaneDrop.current) {
     // Don't do tab reorder — the pane drop zone will handle the action
     // Just clean up tab drag visual state
     handedOffToPaneDrop.current = false;
     setDragIndex(null);
     setDropIndex(null);
     setDragOffset(0);
     return;
   }
   ```

3. Need a ref to the tab bar container to get its bounds — add `tabBarRef`.

### Changes to PaneDropZone.tsx

When handling a drop with `drag.type === 'tab'`:
- Call `moveSessionToPane(drag.sessionId, paneId, direction, position)` from the store
- This creates the split and removes the tab

### Changes to SessionButton.tsx / TabBar.tsx

- Import `usePaneDrag` context
- Pass `startDrag` into the drag handlers
- The SessionButton needs to visually indicate it's being dragged to a pane (optional: add a floating ghost element following the cursor)

### Edge Cases
- If the user drags back into the tab bar after leaving, re-capture pointer and resume tab reorder
- If the dragged tab is the currently selected tab, select the nearest remaining tab after the move
- If the dragged tab is the only tab, moving it into an existing pane should close the now-empty session list — but we need at least one session, so prevent this or create a new empty session

## Files to touch
- `src/components/TabBar.tsx` — Add tab-bar-exit detection, release pointer capture, set drag context
- `src/components/PaneDropZone.tsx` — Handle `drag.type === 'tab'` drops by calling `moveSessionToPane`
- `src/components/SessionButton.tsx` — Minor: pass through drag context integration if needed
