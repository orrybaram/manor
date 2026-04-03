---
title: Register Manor MCP server in Codex config
status: done
priority: medium
assignee: sonnet
blocked_by: []
---

# Register Manor MCP server in Codex config

Implement `CodexConnector.registerMcp()` to register the Manor webview MCP server so Codex sessions can use it.

## Implementation

Codex manages MCP servers differently from Claude. It uses `~/.codex/config.toml` with `[mcp_servers.<name>]` sections, or the `codex mcp add` CLI command.

The simplest approach is to check if `[mcp_servers.manor-webview]` already exists in `~/.codex/config.toml`. If not, append:

```toml
[mcp_servers.manor-webview]
type = "stdio"
command = "node"
args = ["/path/to/mcp-webview-server.js"]
```

Read the existing config.toml, check if `manor-webview` is already registered, and append the section if missing.

## Files to touch
- `electron/agent-connectors.ts` — Replace the no-op `CodexConnector.registerMcp()` with TOML config writing.
