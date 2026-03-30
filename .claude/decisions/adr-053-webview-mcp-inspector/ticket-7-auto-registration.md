---
title: Auto-register CLI tool and MCP server on Manor startup
status: done
priority: critical
assignee: sonnet
blocked_by: [3, 6]
---

# Auto-register CLI tool and MCP server on Manor startup

Manor should auto-install the CLI tool and auto-register the MCP server on startup, so users get webview inspection with zero configuration.

## Implementation

### Auto-install CLI tool

In `electron/main.ts`, call `ensureWebviewCli()` (from ticket 6) at startup, near where `ensureHookScript()` is called. This writes `~/.manor/bin/manor-webview` on every launch (ensuring it's up to date).

### Auto-register MCP server in `~/.claude/settings.json`

Add a new function `registerWebviewMcp()` in `electron/agent-hooks.ts` (or a new file if cleaner). Follow the exact same pattern as `registerClaudeHooks()`:

1. Read `~/.claude/settings.json`
2. Check if `mcpServers.manor-webview` already exists
3. If not, add it:
```json
{
  "mcpServers": {
    "manor-webview": {
      "command": "node",
      "args": ["<path-to-dist-electron>/mcp-webview-server.js"]
    }
  }
}
```

The path to the MCP server script depends on how Manor is installed:
- Development: `path.join(__dirname, "mcp-webview-server.js")` (since main.ts compiles to `dist-electron/main.js`, and the MCP server compiles to `dist-electron/mcp-webview-server.js`, `__dirname` gives the right directory)
- Production (packaged app): The script lives inside the app bundle. Use `path.join(app.getAppPath(), "dist-electron", "mcp-webview-server.js")` or similar. Check how the terminal-host daemon resolves its subprocess path for the pattern.

4. Write back the settings file

Call `registerWebviewMcp()` at startup, near `registerClaudeHooks()`.

### Revert manual config

The `.claude/settings.local.json` should NOT contain MCP configuration. This was already reverted, but verify it doesn't have a `mcpServers` key.

### Idempotency

Like `registerClaudeHooks()`, both registrations must be idempotent — safe to call on every launch without duplicating entries.

## Files to touch
- `electron/main.ts` — call `ensureWebviewCli()` and `registerWebviewMcp()` at startup
- `electron/agent-hooks.ts` — add `registerWebviewMcp()` function (or create a new file)
