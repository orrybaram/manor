---
title: Add project/workspace MCP tools to existing MCP server
status: todo
priority: high
assignee: sonnet
blocked_by: [1]
---

# Add project/workspace MCP tools to existing MCP server

Extend `electron/mcp-webview-server.ts` with 6 new tools for project and workspace management. These call the HTTP endpoints added in ticket 1.

## New tool definitions

Add to the existing `TOOLS` array:

### `list_projects`
- inputSchema: `{ type: "object", properties: {} }`
- Description: "List all projects in Manor with their IDs, names, paths, and workspace counts."

### `get_project`
- inputSchema: `{ type: "object", properties: { projectId: { type: "string", description: "Project ID" } }, required: ["projectId"] }`
- Description: "Get full details for a project including all workspaces."

### `add_project`
- inputSchema: `{ type: "object", properties: { name: { type: "string" }, path: { type: "string", description: "Absolute path to the project directory" } }, required: ["name", "path"] }`
- Description: "Add a new project to Manor by name and directory path."

### `create_workspace`
- inputSchema: properties: `projectId` (required), `name` (required), `branch` (optional), `baseBranch` (optional), `useExistingBranch` (optional boolean)
- Description: "Create a new workspace (git worktree) in a project."

### `list_workspaces`
- inputSchema: `{ projectId: string (required) }`
- Description: "List all workspaces for a project."

### `remove_workspace`
- inputSchema: `{ projectId: string (required), worktreePath: string (required), deleteBranch: boolean (optional) }`
- Description: "Remove a workspace from a project."

## Handler implementations

Add cases to the `handleTool` switch statement:

- `list_projects`: `GET /projects` → format as text listing: `id: name (path) — N workspaces`
- `get_project`: `GET /projects/:id` → format project details with workspace list
- `add_project`: `POST /projects` with `{ name, path }` → return confirmation
- `create_workspace`: `POST /projects/:id/workspaces` with body → return confirmation with new workspace path
- `list_workspaces`: `GET /projects/:id/workspaces` → format as text listing: `path (branch) [main]`
- `remove_workspace`: `DELETE /projects/:id/workspaces` with body → return confirmation

## Files to touch
- `electron/mcp-webview-server.ts` — add 6 tool definitions to TOOLS array, add 6 handler cases to handleTool switch
