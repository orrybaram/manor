---
title: Create WebviewHost component
status: todo
priority: critical
assignee: opus
blocked_by: [1, 2]
---

# Create WebviewHost component

Create the `WebviewHost` component that renders all browser `<webview>` elements in a stable container, positioned as absolute overlays on top of their slots.

## Implementation

Create `src/components/workspace-panes/WebviewHost.tsx`:

### Rendering
- Render a container div with `position: fixed; inset: 0; pointer-events: none; z-index: 1;` (above pane content but below context menus/modals)
- For each browser pane entry in the app store's `paneContentType` where value is `"browser"`, render a `BrowserPane` wrapped in a positioned div
- The positioned div for each webview gets: `position: absolute; pointer-events: auto;` with `top/left/width/height` from the webview host store's slot rect
- When `visible` is false in the slot, set `visibility: hidden` on the wrapper

### Collecting browser panes
- Subscribe to `useAppStore` to get all paneIds where `paneContentType[id] === "browser"`
- This can be a selector that collects browser pane IDs across all workspaces/panels/tabs

### BrowserPane ref management
- For each browser pane rendered, store its `BrowserPaneRef` in the existing `browser-pane-registry`
- The `initialUrl` comes from `paneUrl[paneId]` in the app store (same as current LeafPane logic)
- `onNavStateChange` needs to propagate state back to LeafPane — use a new Zustand store slice or a simple event-based approach. The simplest approach: add a `navStates: Record<string, BrowserPaneNavState>` to the webview host store so LeafPane can subscribe to its pane's nav state.

### Drag overlay
- When `useDragOverlayStore`'s `isDragActive` is true, render a `pointer-events: auto` overlay div on top of each visible webview (same as current `dragOverlay` in BrowserPane.module.css)

### Key considerations
- Use `paneId` as the React key for each BrowserPane — paneIds are stable across tree restructuring (the original pane keeps its ID, only the new pane gets a fresh ID)
- The webview host store's `removeSlot` should NOT unmount the BrowserPane immediately — the pane might just be moving in the tree. Instead, only unmount when the paneId is no longer in `paneContentType`
- Register/unregister in `browser-pane-registry` happens here instead of in LeafPane

## Files to touch
- `src/components/workspace-panes/WebviewHost.tsx` — new file
- `src/store/webview-host-store.ts` — add `navStates` field and `setNavState` action
