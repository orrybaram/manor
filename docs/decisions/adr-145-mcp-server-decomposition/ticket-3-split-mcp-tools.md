---
title: Split MCP tool definitions by domain
status: done
priority: medium
assignee: sonnet
blocked_by: []
---

# Split MCP tool definitions by domain

Decompose `electron/mcp-webview-server.ts` (901 lines) so tool defs + handlers
live in per-domain modules and the entry file is thin. Behavior identical — the
server exposes the exact same tool names and outputs.

New `electron/mcp/`:
- `types.ts` — `ToolResult`, `Http` (`{ get, post, del }`), `ToolDef`, and
  `ToolModule { tools: ToolDef[]; handlers: Record<string, (args, http: Http) =>
  Promise<ToolResult>> }`. Include a `text(value): ToolResult` helper.
- `tools-webview.ts` — the webview tools + handlers (list_webviews,
  screenshot_webview, get_dom, execute_js, click_element, type_text, navigate,
  get_console_logs, get_url, pick_element, get_element_context) plus the pane
  resolution + `ElementContext`/`formatElementContext` helpers they use.
- `tools-projects.ts` — list_projects, get_project, add_project,
  create_workspace, list_workspaces, remove_workspace + the ProjectInfo/
  WorkspaceInfo formatters.
- `tools-agents.ts` — list_issues, start_agent, batch_create_workspaces.

`mcp-webview-server.ts` entry:
- Keep port discovery (`readPort`) and build `BASE_URL`.
- Build an `http: Http` client from the existing `httpGet`/`httpPost`/`httpDelete`.
- `const modules = [webviewModule, projectsModule, agentsModule];`
  `const TOOLS = modules.flatMap(m => m.tools);`
  `const handlers = Object.assign({}, ...modules.map(m => m.handlers));`
- `handleTool(name, args)` → `handlers[name]?.(args, http) ?? text("Unknown tool")`,
  keeping the existing top-level try/catch that maps connection errors to
  "Cannot connect to Manor — is it running?".
- Wire the MCP `Server` exactly as before.

## Files to touch
- `electron/mcp/types.ts` (new), `electron/mcp/tools-webview.ts` (new),
  `electron/mcp/tools-projects.ts` (new), `electron/mcp/tools-agents.ts` (new)
- `electron/mcp-webview-server.ts` — reduce to thin entry
