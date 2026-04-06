---
title: Add project/workspace HTTP endpoints to WebviewServer
status: todo
priority: high
assignee: sonnet
blocked_by: []
---

# Add project/workspace HTTP endpoints to WebviewServer

Extend `electron/webview-server.ts` to handle project and workspace management requests. The WebviewServer constructor needs access to `ProjectManager`.

## Constructor change

Update `WebviewServer` constructor to accept an optional `ProjectManager`:

```ts
constructor(registry: Map<string, number>, projectManager?: ProjectManager) {
  this.registry = registry;
  this.projectManager = projectManager ?? null;
}
```

## New routes

Add these routes inside the existing `handleRequest` method. Route matching already uses `url.pathname` — add new branches for `/projects` prefix.

### `GET /projects`
- Call `projectManager.getProjects()`
- Return JSON array of `ProjectInfo`

### `GET /projects/:id`
- Parse project ID from URL path
- Find matching project from `getProjects()` result
- 404 if not found

### `POST /projects`
- Parse JSON body: `{ name: string, path: string }`
- Call `projectManager.addProject(name, path)`
- Return the new `ProjectInfo`

### `GET /projects/:id/workspaces`
- Get project, return its `workspaces` array

### `POST /projects/:id/workspaces`
- Parse JSON body: `{ name: string, branch?: string, baseBranch?: string, useExistingBranch?: boolean }`
- Call `projectManager.createWorktree(projectId, name, branch, undefined, baseBranch, useExistingBranch)`
- Return updated `ProjectInfo`

### `DELETE /projects/:id/workspaces`
- Parse JSON body: `{ worktreePath: string, deleteBranch?: boolean }`
- Call `projectManager.removeWorktree(projectId, worktreePath, deleteBranch)`
- Return `{ ok: true }`

## Body parsing helper

Add a `readBody(req)` helper (the webview server already has inline body parsing in some handlers — extract to a reusable function):

```ts
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}
```

## Wiring change

Update `electron/ipc/webview.ts` `createWebviewServer()` — it currently doesn't have access to `projectManager`. The simplest fix: make it accept `projectManager` as a parameter:

```ts
export function createWebviewServer(projectManager: ProjectManager): WebviewServer {
  return new WebviewServer(webviewRegistry, projectManager);
}
```

Update `electron/app-lifecycle.ts` line ~166 to pass `projectManager`:

```ts
const webviewServer = webviewIpc.createWebviewServer(projectManager);
```

## Files to touch
- `electron/webview-server.ts` — add ProjectManager field, readBody helper, project/workspace route handlers
- `electron/ipc/webview.ts` — pass projectManager to WebviewServer constructor
- `electron/app-lifecycle.ts` — pass projectManager to createWebviewServer()
