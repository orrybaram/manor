---
title: Project, workspace, and folder routes and tools
status: done
priority: critical
assignee: sonnet
blocked_by: []
---

# Project, workspace, and folder routes and tools

Every operation here is a direct `ProjectManager` call (`electron/persistence.ts`); read each method's signature and return type before wiring it. Follow `electron/routes/projects.ts` exactly: validate body fields with the same helpers it uses, `404` on unknown project, call `notifyProjectsChanged()` after every mutation, `json(200, result)`.

## Routes

New `electron/routes/folders.ts` (`export const folderRoutes`), added to the table in `routes/index.ts` **before** `projectRoutes` (static `folders` segment must precede `:param` rows of equal length — read `router.ts`'s header):

| Method | Path | Body | Calls |
|---|---|---|---|
| GET | `/projects/:projectId/folders` | — | project's `folders` array |
| POST | `/projects/:projectId/folders` | `{ name }` | `createWorkspaceFolder` → returns the folder |
| POST | `/projects/:projectId/folders/:folderId/rename` | `{ name }` | `renameWorkspaceFolder` |
| DELETE | `/projects/:projectId/folders/:folderId` | — | `deleteWorkspaceFolder` |
| POST | `/projects/:projectId/workspaces/folder` | `{ workspacePath, folderId \| null }` | `setWorkspaceFolder` |

Extend `electron/routes/projects.ts`:

| Method | Path | Body | Calls |
|---|---|---|---|
| POST | `/projects/:projectId/workspaces/rename` | `{ workspacePath, name }` | `renameWorkspace` |
| POST | `/projects/:projectId/workspaces/hidden` | `{ workspacePath, hidden }` | `setWorkspaceHidden` |
| POST | `/projects/:projectId/workspaces/reorder` | `{ orderedKeys }` | `reorderWorkspaces` |
| POST | `/projects/:projectId/workspaces/convert-main` | body per method signature | `convertMainToWorktree` |
| GET | `/projects/:projectId/workspaces/quick-merge?workspacePath=` | — | `canQuickMerge` |
| POST | `/projects/:projectId/workspaces/quick-merge` | `{ workspacePath }` | `quickMergeWorktree` |
| GET | `/projects/:projectId/workspaces/issues?workspacePath=` | — | `getWorkspaceIssues` |
| POST | `/projects/:projectId/workspaces/issues` | `{ workspacePath, issue… }` | `linkIssueToWorkspace` |
| DELETE | `/projects/:projectId/workspaces/issues` | `{ workspacePath, issue… }` | `unlinkIssueFromWorkspace` |
| GET | `/projects/:projectId/branches?scope=local\|remote` | — | `listLocalBranches` / `listRemoteBranches` |
| POST | `/projects/:projectId/update` | subset of `updateProject` fields | `updateProject` |
| DELETE | `/projects/:projectId` | — | `removeProject` |
| POST | `/projects/reorder` | `{ orderedIds }` | `reorderProjects` |
| POST | `/projects/resync-default-branches` | — | `resyncDefaultBranches` |

Ordering hazards: `/projects/reorder` and `/projects/resync-default-branches` are static 2-segment POSTs that must precede `POST /projects/:projectId/...`? No — different segment counts never collide; but `/projects/:projectId/workspaces/rename` (4 segments, static tail) vs nothing else 4-segment with a param tail exists today. Run `router.test.ts`; it asserts the table has no shadowing.

## Tools (`electron/mcp/tools-projects.ts`)

One tool per route, named in the existing voice: `list_folders`, `create_folder`, `rename_folder`, `delete_folder`, `set_workspace_folder`, `rename_workspace`, `set_workspace_hidden`, `reorder_workspaces`, `convert_main_to_worktree`, `can_quick_merge`, `quick_merge_workspace`, `list_workspace_issues`, `link_issue`, `unlink_issue`, `list_branches` (with `scope` enum), `update_project`, `remove_project`, `reorder_projects`, `resync_default_branches`. `projectId` and `workspacePath` default via `resolveProjectId` / `resolveWorkspacePath` from `./context`. Destructive tools (`delete_folder`, `remove_project`, `quick_merge_workspace`) say so in their description's first sentence. Output: short confirmation text, or the formatted object for reads (reuse `formatProject`/`formatWorkspace`).

## Tests
- `electron/routes/folders.test.ts`: create → rename → set workspace folder → delete against a `ProjectManager` stub; unknown project → 404; missing `name` → 400.
- `electron/routes/router.test.ts` passes (ordering).
- Extend `electron/__tests__/mcp-webview-server.test.ts` or add `electron/mcp/tools-projects.test.ts` covering `create_folder` and `rename_workspace` through a fake `Http`.

## Files to touch
- `electron/routes/folders.ts` — new
- `electron/routes/folders.test.ts` — new
- `electron/routes/projects.ts` — new rows
- `electron/routes/index.ts` — register `folderRoutes`
- `electron/mcp/tools-projects.ts` — new tools
- `electron/mcp/tools-projects.test.ts` — new
