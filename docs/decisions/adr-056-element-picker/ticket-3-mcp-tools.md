---
title: Add pick_element and get_element_context MCP tools
status: done
priority: high
assignee: sonnet
blocked_by: [2]
---

# Add pick_element and get_element_context MCP tools

Expose the new picker functionality to Claude Code via MCP tools.

### `pick_element`
- Description: "Activate element picker in a webview — the user selects an element and its context is returned."
- Input: `{ paneId?: string }`
- Calls `POST /webview/:id/pick-element` on the HTTP server
- Returns the structured element context as text

### `get_element_context`
- Description: "Get detailed context for a DOM element by CSS selector, without requiring user interaction."
- Input: `{ paneId?: string, selector: string }`
- Calls `POST /webview/:id/element-context` on the HTTP server
- Returns the structured element context as text

Both tools should format the output using the `<picked_element>` XML format defined in the ADR.

## Files to touch
- `electron/mcp-webview-server.ts` — add tool definitions and handlers
