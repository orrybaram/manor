---
title: Tests for webview server and MCP server
status: done
priority: high
assignee: opus
blocked_by: [2, 3]
---

# Tests for webview server and MCP server

Write comprehensive tests for the webview HTTP server and the MCP server. Follow the existing test patterns in `electron/__tests__/agent-hooks.test.ts` (vitest, HTTP helpers, start/stop lifecycle, relay callbacks).

## Test file 1: `electron/__tests__/webview-server.test.ts`

Test the `WebviewServer` class in isolation. Since we can't create real `webContents` in vitest (no Electron runtime), mock the Electron APIs.

### Setup
- Mock `electron` module: `webContents.fromId()` returns a mock webContents object
- Mock webContents methods: `getURL()`, `getTitle()`, `capturePage()`, `executeJavaScript()`, `loadURL()`, `sendInputEvent()`
- Create a real `Map<string, number>` as the registry
- Start the server on a random port, stop after each test

### Tests to write

**Server lifecycle:**
- Assigns a port > 0 on start
- Writes port file to `~/.manor/webview-server-port`
- stop() cleans up port file
- Supports multiple start/stop cycles

**GET /webviews:**
- Returns empty array when no webviews registered
- Returns correct paneId, url, title for registered webviews
- Returns multiple webviews when multiple registered

**POST /webview/:id/screenshot:**
- Returns 404 when paneId not in registry
- Returns base64 PNG image data for valid paneId
- Calls `webContents.capturePage()` with no arguments

**POST /webview/:id/execute-js:**
- Returns result of `executeJavaScript()` call
- Returns error message when JS throws
- Handles non-string return values (objects, numbers, arrays)

**POST /webview/:id/dom:**
- Returns simplified HTML from the webview
- Calls `executeJavaScript()` with the DOM extraction script

**POST /webview/:id/click:**
- Accepts selector, resolves to coordinates via executeJavaScript, sends mouse events
- Accepts raw x,y coordinates
- Returns 400 when neither selector nor coordinates provided

**POST /webview/:id/type:**
- Sends char input events for each character
- Clicks element first if selector provided

**POST /webview/:id/navigate:**
- Calls `webContents.loadURL()` with the provided URL
- Returns 400 for missing url

**GET /webview/:id/console-logs:**
- Returns empty array when no logs buffered
- Returns buffered log entries after console-message events
- Ring buffer caps at 200 entries

**GET /webview/:id/url:**
- Returns current URL from `webContents.getURL()`

**Error handling:**
- Returns 404 for unknown routes
- Returns 404 for unknown paneId
- Returns 410 when webContents is destroyed (fromId returns null)
- Handles JSON parse errors in request body gracefully

## Test file 2: `electron/__tests__/mcp-webview-server.test.ts`

Test the MCP server's tool definitions and HTTP proxying logic. Extract the tool handler logic into testable functions rather than testing via stdio.

### Tests to write

**Tool resolution (paneId defaulting):**
- When paneId provided, uses it directly
- When paneId omitted and exactly one webview exists, uses that one
- When paneId omitted and multiple webviews exist, returns error message

**HTTP client error handling:**
- Returns descriptive error when port file missing (Manor not running)
- Returns descriptive error when connection refused
- Returns descriptive error when server returns 404

**Screenshot tool:**
- Returns image content block with base64 data and correct mime type

## Files to touch
- `electron/__tests__/webview-server.test.ts` — new file
- `electron/__tests__/mcp-webview-server.test.ts` — new file
