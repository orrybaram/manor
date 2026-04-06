---
title: Rename MCP server registration from manor-webview to manor
status: todo
priority: medium
assignee: haiku
blocked_by: [1, 2]
---

# Rename MCP server registration from manor-webview to manor

The MCP server now handles more than just webview tools. Rename it from `manor-webview` to `manor` in agent connector registrations.

## Changes

### `electron/agent-connectors.ts`

**ClaudeConnector.registerMcp()** (line ~134):
- Change `mcpServers["manor-webview"]` to `mcpServers["manor"]`
- Also delete the old `manor-webview` entry if it exists (cleanup):
  ```ts
  if (mcpServers["manor-webview"]) {
    delete mcpServers["manor-webview"];
  }
  ```
- Update `needsUpdate` check to look at `mcpServers["manor"]`

**CodexConnector.registerMcp()** (line ~289):
- Change `[mcp_servers.manor-webview]` check and section to `[mcp_servers.manor]`

**PiConnector.registerMcp()** — no changes needed (currently a no-op)

### `electron/mcp-webview-server.ts`

Update the server name in the Server constructor (line ~509):
```ts
const server = new Server(
  { name: "manor", version: "0.1.0" },
  { capabilities: { tools: {} } },
);
```

Update the stderr log prefix from `[mcp-webview]` to `[mcp-manor]`.

## Files to touch
- `electron/agent-connectors.ts` — rename `manor-webview` → `manor` in ClaudeConnector and CodexConnector
- `electron/mcp-webview-server.ts` — update server name and log prefix
