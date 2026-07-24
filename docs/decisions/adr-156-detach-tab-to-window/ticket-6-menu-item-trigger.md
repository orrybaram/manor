---
title: "Move tab to new window" menu item
status: todo
priority: high
assignee: sonnet
blocked_by: [4]
---

# "Move tab to new window" menu item

Add the reliable, discoverable trigger: a tab menu action that detaches the tab
into a new window centered on the current one. Same store + IPC path as drag-out,
no drag geometry.

## Requirements

1. **Add the action** to the tab's context menu. Find the existing tab
   context/right-click menu (start at `src/components/tabbar/TabButton.tsx` and
   the tab menu component it opens; the store already has `duplicateTab`,
   `togglePinTab`, `requestCloseTab` — put "Move tab to new window" alongside
   these). Use the shared UI menu components, not raw elements
   (per `.claude/rules/ui-components.md`).

2. **Wire the handler:**
   ```ts
   const payload = serializeTabForDetach(tabId);
   const bounds = await window.electronAPI.window.getBounds();
   const spawnBounds = {
     x: bounds.x + 40, y: bounds.y + 40, width: 900, height: 600,
   };
   await window.electronAPI.window.detachTab(payload, spawnBounds);
   removeDetachedTabLocally(tabId);
   ```
   (offset from the current window so the new window is visibly distinct).

3. **Disable / hide** the item when it wouldn't make sense (e.g. if the panel has
   only one tab and detaching would leave an empty window — use judgment; a
   single-tab panel detaching is acceptable, an empty source panel should
   collapse via `removeDetachedTabLocally`'s reused cleanup).

## Files to touch
- `src/components/tabbar/TabButton.tsx` (and its tab menu component) — add the
  menu item + handler.

## Notes
- Depends on the store actions (ticket 3) and detached bootstrap (ticket 4) being
  in place. Reuses everything; this ticket is only the UI entry point.
- Keep it consistent with the existing tab menu items' styling and ordering.
