---
title: Add picker endpoints to webview HTTP server
status: done
priority: high
assignee: sonnet
blocked_by: [1]
---

# Add picker endpoints to webview HTTP server

Add two new endpoints to the webview HTTP server for element picking.

### `POST /webview/:id/pick-element`
- Inject the picker script into the webview via `wc.executeJavaScript()`
- Listen for `console-message` events with the `__MANOR_PICK__:` prefix
- Return the parsed JSON metadata when received
- Handle cancellation (`__MANOR_PICK_CANCEL__`) by returning `{ cancelled: true }`
- Timeout after 30 seconds if no selection is made

### `POST /webview/:id/element-context`
- Accept a `selector` string in the request body
- Execute JS in the webview to find the element and extract the same metadata as the picker (HTML, styles, bbox, accessibility, React fiber)
- Return the metadata JSON without requiring user interaction

Both endpoints should use the same metadata extraction logic from the picker script.

## Files to touch
- `electron/webview-server.ts` — add `pick-element` and `element-context` route handlers
- `electron/picker-script.ts` — import the script for injection
