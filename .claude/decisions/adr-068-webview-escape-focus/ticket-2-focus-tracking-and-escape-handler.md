---
title: Track webview focus state and handle escape in BrowserPane
status: done
priority: high
assignee: sonnet
blocked_by: [1]
---

# Track webview focus state and handle escape in BrowserPane

## Focus tracking

In `BrowserPane.tsx`:
1. Add `webviewFocused: boolean` to `BrowserPaneNavState` (default `false`)
2. In the `useEffect` that sets up webview event listeners, add `focus` and `blur` event listeners on the webview element
3. On `focus`: call `fireNavStateChange({ webviewFocused: true })`
4. On `blur`: call `fireNavStateChange({ webviewFocused: false })`
5. Clean up both listeners in the effect's return function

## Escape handler

In the same `useEffect`:
1. Subscribe to `window.electronAPI.webview.onEscape((escapePaneId) => { ... })`
2. When `escapePaneId` matches this pane's `paneId`:
   - Call `webviewRef.current?.blur()` to remove focus from the webview
   - This will trigger the `blur` event listener above, which updates `webviewFocused` to `false`
3. Clean up the subscription in the effect's return function

## Files to touch
- `src/components/BrowserPane.tsx` — add focus/blur listeners, escape handler, update `BrowserPaneNavState` type
