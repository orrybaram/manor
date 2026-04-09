---
title: Wire up WebviewHost and WebviewSlot into the app
status: todo
priority: critical
assignee: opus
blocked_by: [1, 2, 3]
---

# Wire up WebviewHost and WebviewSlot into the app

Replace the inline `BrowserPane` rendering in `LeafPane` with `WebviewSlot`, mount `WebviewHost` in `App.tsx`, and ensure all browser functionality (nav controls, find bar, URL input, context menu) continues to work.

## Implementation

### App.tsx
- Import `WebviewHost` and render it inside `PaneDragProvider`, after the `main-content` div (sibling, not child — so it overlays the entire content area)
- It should be rendered unconditionally (not gated by `activeWorkspacePath`)

### LeafPane.tsx
- Replace the `<BrowserPane>` render (lines 462-469) with `<WebviewSlot paneId={paneId} visible={true} />`
- The `visible` prop should be `true` — tab visibility is already handled by `TAB_HIDDEN_STYLE` on the parent which makes the slot have zero rect
- Remove the `browserRef` local ref — instead, get the `BrowserPaneRef` from `browser-pane-registry` via `getBrowserPaneRef(paneId)` when needed (for nav button clicks, URL input handlers, etc.)
- The `navState` is now read from the webview host store instead of local state: `const navState = useWebviewHostStore((s) => s.navStates[paneId])`
- Remove the `handleNavStateChange` callback and `useMountEffect` for browser pane registration (both move to WebviewHost)
- Keep all the status bar JSX (nav buttons, URL input, find bar) — they just read from the store and call registry refs instead of local refs

### BrowserPane registration
- Remove `registerBrowserPane`/`unregisterBrowserPane` calls from `LeafPane.tsx` (lines 75-91) — this is now handled by `WebviewHost`

### Cleanup
- Remove the `BrowserPane` import from `LeafPane.tsx`
- The `PaneContextMenu` wrapper for browser panes should wrap the `WebviewSlot` instead

### Key edge cases
- When a new browser pane is created (via split, new tab, convert-to), `WebviewHost` should detect the new entry in `paneContentType` and render a new `BrowserPane`
- When a browser pane is closed, `WebviewHost` should detect the removal and unmount the `BrowserPane`
- URL input handlers: `browserRef.current?.urlInputHandlers` is accessed in the JSX — replace with `getBrowserPaneRef(paneId)?.urlInputHandlers`. Since the ref might not exist yet on first render (WebviewHost hasn't mounted the BrowserPane yet), add null checks

## Files to touch
- `src/App.tsx` — add WebviewHost render
- `src/components/workspace-panes/LeafPane.tsx` — replace BrowserPane with WebviewSlot, read nav state from store
- `src/components/workspace-panes/LeafPane.tsx` — remove browser registration mount effect
