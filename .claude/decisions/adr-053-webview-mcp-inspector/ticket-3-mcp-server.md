---
title: MCP server — expose webview tools to Claude Code
status: done
priority: critical
assignee: opus
blocked_by: [2]
---

# MCP server — expose webview tools to Claude Code

Create a standalone MCP server that proxies Claude's tool calls to the webview HTTP server from ticket 2.

## Implementation

### New file: `electron/mcp-webview-server.ts`

This runs as a standalone Node process (not inside Electron). It uses `@modelcontextprotocol/sdk` with stdio transport.

**Discovery**: On startup, read port from `~/.manor/webview-server-port`. If the file doesn't exist, print a helpful error and exit (Manor isn't running or webview server isn't started).

**HTTP client**: Use Node's built-in `fetch` (available in Node 18+) to call the webview HTTP API.

### Tools

Each tool calls the corresponding HTTP endpoint. All tools accept an optional `paneId` parameter. If omitted, call `GET /webviews` first — if exactly one webview exists, use that; otherwise return an error asking the user to specify which pane.

**`list_webviews`**
- No required params
- Calls `GET /webviews`
- Returns text listing of panes: id, url, title

**`screenshot_webview`**
- Params: `paneId?: string`
- Calls `POST /webview/:id/screenshot`
- Returns the image as an MCP image content block (base64 PNG)

**`get_dom`**
- Params: `paneId?: string`
- Calls `POST /webview/:id/dom`
- Returns the simplified HTML as text

**`execute_js`**
- Params: `paneId?: string`, `code: string` (required)
- Calls `POST /webview/:id/execute-js`
- Returns the result as text (JSON stringified)

**`click_element`**
- Params: `paneId?: string`, `selector?: string`, `x?: number`, `y?: number`
- Calls `POST /webview/:id/click`
- Returns confirmation text

**`type_text`**
- Params: `paneId?: string`, `selector: string`, `text: string`
- Calls `POST /webview/:id/type`
- Returns confirmation text

**`navigate`**
- Params: `paneId?: string`, `url: string`
- Calls `POST /webview/:id/navigate`
- Returns confirmation text

**`get_console_logs`**
- Params: `paneId?: string`
- Calls `GET /webview/:id/console-logs`
- Returns formatted log entries as text

**`get_url`**
- Params: `paneId?: string`
- Calls `GET /webview/:id/url`
- Returns the URL as text

### Error handling

- If Manor isn't running (port file missing or connection refused): return clear error text
- If webview not found: return error suggesting `list_webviews` first
- All errors should be descriptive — Claude needs to understand what went wrong

### Build consideration

This file needs to be compiled separately since it runs outside Electron. It should be buildable with `esbuild` or just `tsc` as a standalone script. Check how the existing `electron/` files are built (vite-plugin-electron likely handles this). The file should end up at `dist-electron/mcp-webview-server.js`.

## New dependency

Add `@modelcontextprotocol/sdk` to `dependencies` in `package.json`.

## Files to touch
- `electron/mcp-webview-server.ts` — new file, the MCP server
- `package.json` — add `@modelcontextprotocol/sdk` dependency
