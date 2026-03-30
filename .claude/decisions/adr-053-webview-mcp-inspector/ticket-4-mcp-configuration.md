---
title: "[SUPERSEDED] Configure MCP server in Claude Code settings"
status: done
priority: high
assignee: haiku
blocked_by: [3]
---

# Configure MCP server in Claude Code settings

Wire up the MCP server so Claude Code discovers it automatically.

## Implementation

### Update `.claude/settings.local.json`

Add the MCP server configuration. The command should point to the built MCP server script. Since Manor's electron files are compiled to `dist-electron/`, the path will be:

```json
{
  "mcpServers": {
    "manor-webview": {
      "command": "node",
      "args": ["dist-electron/mcp-webview-server.js"],
      "cwd": "/Users/orrybaram/Code/manor"
    }
  }
}
```

Merge this with existing settings in the file (preserve existing `permissions` etc.).

### Update `electron/main.ts` — auto-start webview server

Make sure the webview server starts in `app.whenReady()`. This was specified in ticket 2 but verify it's wired up.

## Files to touch
- `.claude/settings.local.json` — add mcpServers config
