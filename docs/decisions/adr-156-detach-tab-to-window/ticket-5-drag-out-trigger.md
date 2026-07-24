---
title: Drag-out trigger in TabBar
status: done
priority: high
assignee: opus
blocked_by: [4]
---

# Drag-out trigger in TabBar

Let the user detach a tab by dragging it out past the window edge and releasing.
Extend the existing hand-rolled pointer drag in `TabBar.tsx` — do not add a DnD
library.

## Current behavior (context)

`src/components/tabbar/TabBar/TabBar.tsx` `handleDragStart` (`:80-233`):
- On drag, when the pointer moves below the tab bar (`ev.clientY > barRect.bottom
  + 20`, `:157`), it **releases pointer capture** (`:160`) and hands off to
  in-window pane drop zones via `startDrag({ type: "tab", ... })` (`:164`), then
  registers a `globalCleanup` that just calls `endDrag()` on `pointerup`
  (`:173-179`).

## Requirements

1. **Fetch window bounds at drag start.** Call
   `window.electronAPI.window.getBounds()` (ticket 2) once when a drag becomes
   active; store it in a ref. Used to test "released outside the window".

2. **Keep receiving events outside the window.** Reconcile with the current
   capture-release at `:160`. Pointer capture keeps `pointermove`/`pointerup`
   flowing (with `screenX`/`screenY`) even outside the OS window while the button
   is held; releasing capture stops that. Ensure the drag path that should be
   able to leave the window retains enough signal to detect an outside-window
   release — track the latest `ev.screenX/ev.screenY` on every move.

3. **Detect outside-window release.** In the `globalCleanup`/`pointerup` handler
   for a handed-off tab drag, compare the final `screenX/screenY` against the
   window's outer bounds:
   - **Outside bounds** → detach:
     - `const payload = serializeTabForDetach(tabId)`
     - compute `spawnBounds` from the drop point (place the new window so the tab
       lands under the cursor; a reasonable default size, e.g. 900×600)
     - `const id = await window.electronAPI.window.detachTab(payload, spawnBounds)`
     - `removeDetachedTabLocally(tabId)` in this (source) store
     - then `endDrag()`
   - **Inside bounds** → keep existing behavior (pane drop / reorder / cancel).

4. **Guard against double-handling.** The existing pane-drop path
   (`handleTabBarDrop`, `:266`) and reorder-on-`onUp` (`:206-219`) must not also
   fire when a detach happens. Make the outside-window branch terminal.

## Files to touch
- `src/components/tabbar/TabBar/TabBar.tsx` — fetch bounds at drag start; track
  screen coords; branch to detach on outside-window release; guard other paths.

## Notes
- Multi-monitor: use screen coordinates (`screenX/screenY`) and the window's
  screen-space outer bounds, not client coords.
- If pointer-capture-outside-window proves unreliable in practice, the menu item
  (ticket 6) is the guaranteed path — ship both; don't block on perfecting drag
  geometry.
