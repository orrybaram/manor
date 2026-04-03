---
title: Intercept browser keybinds in webview before-input-event
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Intercept browser keybinds in webview before-input-event

Extend the `before-input-event` handler in `electron/main.ts` inside the `webview:register` IPC handler to intercept browser keybindings when the webview has focus.

## What to do

1. In `electron/main.ts`, modify the `escapeHandler` (or add a new handler alongside it) in the `webview:register` handler to also check for browser keybindings:

   - **Cmd+= (zoom in)**: `ev.preventDefault()`, then `wc.setZoomLevel(Math.min(wc.getZoomLevel() + 0.5, 5))`
   - **Cmd+- (zoom out)**: `ev.preventDefault()`, then `wc.setZoomLevel(Math.max(wc.getZoomLevel() - 0.5, -3))`
   - **Cmd+0 (zoom reset)**: `ev.preventDefault()`, then `wc.setZoomLevel(0)`
   - **Cmd+R (reload)**: `ev.preventDefault()`, then `wc.reload()`
   - **Cmd+L (focus URL bar)**: `ev.preventDefault()`, then `rendererWebContents.send("webview:focus-url", paneId)`

2. Use `input.meta` (macOS) check for Cmd. Match the key values: `=`, `-`, `0`, `r`, `l`. Ensure no other modifiers (shift, alt, ctrl) are pressed for these.

3. In `electron/preload.ts`, add `onFocusUrl` to the webview API:
   ```typescript
   onFocusUrl: (callback: (paneId: string) => void) =>
     onChannel('webview:focus-url', callback),
   ```

4. In `src/electron.d.ts`, add the type for `onFocusUrl`.

5. In `src/components/BrowserPane.tsx`, subscribe to `onFocusUrl` in the useEffect (alongside `onEscape`), and when received, blur the webview and focus+select the URL input via `document.querySelector`.

## Files to touch
- `electron/main.ts` — extend `before-input-event` handler in `webview:register`
- `electron/preload.ts` — add `onFocusUrl` channel
- `src/electron.d.ts` — add type declaration
- `src/components/BrowserPane.tsx` — subscribe to `onFocusUrl` IPC
