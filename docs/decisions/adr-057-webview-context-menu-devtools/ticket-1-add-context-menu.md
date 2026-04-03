---
title: Add context-menu with Inspect Element to webview webContents
status: done
priority: medium
assignee: sonnet
blocked_by: []
---

# Add context-menu with Inspect Element to webview webContents

In `electron/main.ts`, add a right-click context menu to each registered webview that offers "Inspect Element".

## Implementation

1. Import `Menu` from electron (already available via `Menu.buildFromTemplate` usage)
2. Create a `Map<string, () => void>` to store cleanup functions for context-menu listeners
3. In the `webview:register` handler, after setting the registry entry:
   - Get the webContents via `webContents.fromId(webContentsId)`
   - Attach a `context-menu` event listener that receives `(event, params)` where `params` has `{ x, y }`
   - In the listener, build a `Menu` with one item: `{ label: "Inspect Element", click: () => wc.inspectElement(params.x, params.y) }`
   - Store the cleanup function in the map
4. In the `webview:unregister` handler, call and remove the cleanup function

## Files to touch
- `electron/main.ts` — modify `webview:register` and `webview:unregister` IPC handlers
