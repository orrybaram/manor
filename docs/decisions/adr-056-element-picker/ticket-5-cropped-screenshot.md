---
title: Add cropped element screenshot support
status: done
priority: medium
assignee: sonnet
blocked_by: [2]
---

# Add cropped element screenshot support

After the picker captures an element's bounding box, take a cropped screenshot of just that element's region.

### Implementation
- In the `pick-element` endpoint handler, after receiving the picker result with bounding box coordinates, use `wc.capturePage({ x, y, width, height })` to capture the element's region
- Include the base64 PNG in the picker result as `screenshot` field
- In the `element-context` endpoint, also capture the cropped screenshot after finding the element
- In the MCP tools, return the screenshot as an `image` content block alongside the text context

### Considerations
- Device pixel ratio: multiply coordinates by `wc.getZoomFactor()` for correct capture region
- Clamp coordinates to viewport bounds
- If the element is partially off-screen, capture what's visible

## Files to touch
- `electron/webview-server.ts` — add screenshot capture after picker/context results
- `electron/mcp-webview-server.ts` — return image content block in pick_element and get_element_context
