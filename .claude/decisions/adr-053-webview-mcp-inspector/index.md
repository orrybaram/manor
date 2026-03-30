---
type: adr
status: accepted
database:
  schema:
    status:
      type: select
      options: [todo, in-progress, review, done]
      default: todo
    priority:
      type: select
      options: [critical, high, medium, low]
    assignee:
      type: select
      options: [opus, sonnet, haiku]
  defaultView: board
  groupBy: status
---

# ADR-053: Webview MCP Inspector — Let Claude Inspect & Interact with Browser Panes

## Context

Manor now supports in-app browser panes (ADR-052) that render webviews for previewing dev servers. Currently, Claude Code running in a Manor terminal has no way to see or interact with what's rendered in these webviews. This means Claude can't verify that UI changes look correct, debug rendering issues, check console errors, or interact with the page.

The goal is to let Claude:
1. **See** what's rendered (screenshots, DOM/accessibility tree)
2. **Read** page state (console logs, network requests, JS evaluation)
3. **Interact** with the page (click, type, navigate)

This creates a powerful workflow: Claude edits code, then verifies the result visually in the webview without the user needing to describe what they see.

## Decision

### Approach: CDP-backed MCP server connected via local HTTP API

Build a three-layer system:

**Layer 1 — Webview Bridge (Electron main process)**

Add a local HTTP server in the main process (similar pattern to `AgentHookServer`) that exposes webview operations. The main process can access any webview's `webContents` via Electron's `webContents.getAllWebContents()` or by tracking webview `webContents` IDs when they're created.

Key insight: Electron's `<webview>` tags create guest `webContents` that the main process can access. Using `webContents.debugger.attach()` gives full Chrome DevTools Protocol (CDP) access. For simpler operations, `webContents.executeJavaScript()` and `webContents.capturePage()` are sufficient.

The HTTP server runs on `127.0.0.1` on a random port (same pattern as `AgentHookServer`). The port is written to `~/.manor/webview-server-port` so the MCP server can discover it.

API endpoints:
- `GET /webviews` — list all open webviews (id, url, title)
- `POST /webview/:id/screenshot` — capture page as PNG base64
- `POST /webview/:id/execute-js` — run JavaScript and return result
- `POST /webview/:id/dom` — return simplified DOM or accessibility tree
- `POST /webview/:id/click` — click element by CSS selector or coordinates
- `POST /webview/:id/type` — type text into element
- `POST /webview/:id/navigate` — navigate to URL
- `GET /webview/:id/console-logs` — return buffered console messages
- `GET /webview/:id/url` — get current URL

**Layer 2 — Webview Registry (renderer → main IPC)**

The renderer needs to tell the main process about webview `webContents` IDs so we can map paneIds to webContents. When a `<webview>` element fires its `did-attach` event, it provides the `webContentsId`. The renderer sends this to main via a new IPC handler `webview:register(paneId, webContentsId)`. When the pane is destroyed, `webview:unregister(paneId)` cleans up.

The main process maintains a `Map<string, number>` (paneId → webContentsId) and uses `webContents.fromId(id)` to get the actual webContents for operations.

**Layer 3 — CLI Tool (universal agent interface)**

A shell script installed at `~/.manor/bin/manor-webview` that wraps the HTTP API. Every CLI agent (Claude Code, Codex, OpenCode, Cursor, etc.) can use it via shell commands — zero configuration required.

Commands:
```
manor-webview list                          # list open webviews
manor-webview screenshot [paneId]           # capture as base64 PNG
manor-webview dom [paneId]                  # simplified DOM snapshot
manor-webview exec-js [paneId] <code>       # execute JavaScript
manor-webview click [paneId] --selector <s> # click element
manor-webview click [paneId] --x <n> --y <n>
manor-webview type [paneId] --selector <s> --text <t>
manor-webview navigate [paneId] <url>       # navigate to URL
manor-webview console-logs [paneId]         # buffered console output
manor-webview url [paneId]                  # current URL
```

When `paneId` is omitted and exactly one webview is open, it targets that one automatically.

Manor auto-installs this script on startup (same pattern as `~/.manor/hooks/notify.sh`).

**Layer 4 — MCP Server (auto-registered for Claude Code)**

A standalone Node.js script using `@modelcontextprotocol/sdk` that proxies MCP tool calls to the Layer 1 HTTP API. This gives Claude Code richer integration (image content blocks for screenshots, structured tool definitions).

Manor auto-registers the MCP server in `~/.claude/settings.json` on startup, using the same pattern as `registerClaudeHooks()`. No manual configuration needed.

MCP tools exposed:
| Tool | Description |
|------|-------------|
| `list_webviews` | List all open browser panes with their paneId, URL, and title |
| `screenshot_webview` | Capture the webview as a PNG image (returned as base64 image content) |
| `get_dom` | Return the page's DOM as simplified HTML or accessibility tree |
| `execute_js` | Run arbitrary JavaScript in the webview and return the result |
| `click_element` | Click an element by CSS selector or x,y coordinates |
| `type_text` | Type text into an element identified by CSS selector |
| `navigate` | Navigate the webview to a URL |
| `get_console_logs` | Return recent console.log/warn/error output |
| `get_url` | Get the current URL of a webview |

### Console log buffering

The main process attaches a `console-message` event listener to each registered webview's `webContents`. Messages are buffered in a ring buffer (last 200 entries per webview) with timestamp, level, and message text.

### Webview identification

Tools accept a `paneId` parameter. If omitted and there's exactly one browser pane open, it targets that one (convenience for the common case).

### Auto-registration (zero config)

Manor handles all setup automatically on startup:
1. Installs `~/.manor/bin/manor-webview` CLI script (universal, all agents)
2. Registers MCP server in `~/.claude/settings.json` (Claude Code integration)
3. Writes webview server port to `~/.manor/webview-server-port` (discovery)

## Consequences

**Better:**
- Any CLI agent can verify UI changes visually — complete the feedback loop
- Works out of the box: Manor auto-installs CLI tool and auto-registers MCP
- Universal: CLI tool works for all agents via shell commands; MCP gives richer Claude Code integration
- No user configuration needed — zero-setup experience
- Follows established Manor patterns (auto-install like hook scripts, auto-register like Claude hooks)

**Harder:**
- New dependency: `@modelcontextprotocol/sdk`
- Webview `webContents` tracking adds complexity to the lifecycle
- Two client interfaces to maintain (CLI + MCP), though both are thin wrappers over the same HTTP API
- MCP/CLI must handle the case where Manor isn't running (graceful error)

**Testing:**
- WebviewServer unit tests: mock Electron's `webContents` API, test all HTTP endpoints, lifecycle, error handling, console log ring buffer
- MCP server unit tests: test tool handler logic, paneId defaulting, HTTP client error handling
- Follow existing patterns from `electron/__tests__/agent-hooks.test.ts` (vitest, HTTP helpers, start/stop lifecycle)

**Risks:**
- Security: the MCP server can execute arbitrary JS in webviews. Mitigated by localhost-only binding and the fact that Claude Code already has full shell access.
- Stale webContents IDs if webview is destroyed between register and use — handle with try/catch.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
