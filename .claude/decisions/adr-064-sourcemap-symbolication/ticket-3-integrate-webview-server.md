---
title: Integrate symbolication into webview server element-context
status: done
priority: high
assignee: sonnet
blocked_by: [1]
---

# Integrate symbolication into webview server element-context

Wire the sourcemap symbolication module into `electron/webview-server.ts`'s `element-context` endpoint so it also returns resolved source file paths.

### Changes

1. **Import the symbolication script string** from `electron/sourcemap-symbolication.ts`

2. **Prepend symbolication to the `executeJavaScript` call**: The `element-context` endpoint at ~line 500 builds an inline script string. Prepend `SYMBOLICATION_SCRIPT` so the symbolication functions are available.

3. **Make `getReactFiberInfo` async** in the inline script (same changes as ticket-2 but applied to the duplicated copy in webview-server.ts).

4. **Ensure the `executeJavaScript` promise resolves after async work**: The inline script must `await` the async `getReactFiberInfo` call. Wrap the script body in an async IIFE if it isn't already.

### Testing approach
- Manual: use the MCP `get_element_context` tool on a Next.js app, verify source paths resolve correctly

## Files to touch
- `electron/webview-server.ts` — import symbolication string, make inline getReactFiberInfo async, prepend symbolication script
