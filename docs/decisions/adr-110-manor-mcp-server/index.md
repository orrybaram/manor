---
type: adr
status: proposed
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

# ADR-110: Manor MCP Server — Project & Workspace Tools

## Context

Manor already has an MCP server (`mcp-webview-server.ts`) for webview inspection that talks to an HTTP API server (`webview-server.ts`) inside Electron. Agents can inspect browser panes but can't manage Manor itself — creating projects, spawning workspaces, etc.

There's no reason to create a second MCP server. We should extend the existing one.

## Decision

**Extend the existing MCP server and HTTP API server** with project/workspace management tools.

### Changes

1. **`electron/webview-server.ts`** — Add project/workspace HTTP endpoints to the existing `WebviewServer`. The server already handles routing via URL path matching. The constructor will accept a `ProjectManager` in addition to the webview registry.

2. **`electron/mcp-webview-server.ts`** — Add new MCP tool definitions and handlers that call the new HTTP endpoints.

3. **Rename the MCP server** from `manor-webview` to `manor` in agent connector registration (since it now does more than webview).

### New HTTP Endpoints (on existing webview server)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/projects` | GET | List all projects |
| `/projects/:id` | GET | Get single project |
| `/projects` | POST | Add project (body: `{name, path}`) |
| `/projects/:id/workspaces` | GET | List workspaces |
| `/projects/:id/workspaces` | POST | Create workspace (body: `{name, branch?, baseBranch?, useExistingBranch?}`) |
| `/projects/:id/workspaces` | DELETE | Remove workspace (body: `{worktreePath, deleteBranch?}`) |

### New MCP Tools

| Tool | Description |
|------|-------------|
| `list_projects` | List all projects with IDs, names, paths, workspace counts |
| `get_project` | Get full project details including workspaces |
| `add_project` | Add a new project by name + path |
| `create_workspace` | Create a workspace (git worktree) |
| `list_workspaces` | List workspaces for a project |
| `remove_workspace` | Remove a workspace |

### Future Use Cases (not in v1)

- **`open_browser_pane`** — Launch a browser tab to a URL
- **`start_agent`** — Launch an agent session in a workspace with a prompt
- **`get_agent_status`** — Check running agents across workspaces
- **`batch_create_workspaces`** — Create workspaces from GitHub issues
- **`focus_workspace`** — Switch active workspace
- **`merge_workspace`** — Quick-merge back to main
- **`run_command`** — Execute a custom command in a workspace terminal
- **`link_issue`** — Link GitHub/Linear issue to workspace

## Consequences

**Better:**
- Single MCP server, single HTTP server — no new architectural concepts
- Agents can orchestrate Manor programmatically
- Enables multi-agent workflows (fan-out GitHub issues into parallel workspaces)

**Harder:**
- WebviewServer grows in scope (but the routes are cleanly separated by URL prefix)

**Risks:**
- Renaming MCP server from `manor-webview` to `manor` needs to clean up old config entry

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
