---
title: Renderer store actions, folder collapse state, and grouping utils
status: in-progress
priority: high
assignee: sonnet
blocked_by: [1]
---

# Renderer store actions, folder collapse state, and grouping utils

Mirror the folder model into `src/store/project-store.ts`, add optimistic
actions, add persisted collapse state for folders, and create the pure
grouping/ordering helpers the UI ticket will consume.

## Store types (`src/store/project-store.ts`)

- `export interface WorkspaceFolder { id: string; name: string }`
- `WorkspaceInfo`: add `folderId?: string | null;`
- `ProjectInfo`: add `folders: WorkspaceFolder[];`
- In `src/electron.d.ts`, replace the inline `{ id: string; name: string }`
  return type from ticket 1 with
  `import("./store/project-store").WorkspaceFolder`.

## Actions

Follow `setWorkspaceHidden` (optimistic local update, then IPC):

- `createWorkspaceFolder(projectId, name): Promise<WorkspaceFolder | null>` —
  awaits `window.electronAPI.projects.createWorkspaceFolder`; on a non-null
  result, append it to that project's `folders`. Return it.
- `renameWorkspaceFolder(projectId, folderId, name): Promise<void>` — update
  the folder name locally (trimmed), then IPC.
- `deleteWorkspaceFolder(projectId, folderId): Promise<void>` — remove the
  folder locally, set `folderId: null` on any workspace that pointed at it,
  drop its collapse key, then IPC.
- `setWorkspaceFolder(projectId, workspacePath, folderId | null): Promise<void>`
  — set `folderId` on the workspace locally, then IPC.

## Collapse state

Model on `collapsedProjectIds` exactly:

- `collapsedFolderKeys: Set<string>` where a key is `${projectId}/${folderId}`.
  Export `folderCollapseKey(projectId, folderId)` helper.
- `localStorage` key `manor:collapsedWorkspaceFolderKeys`, with
  `loadCollapsedFolderKeys()` / `saveCollapsedFolderKeys()` mirroring the
  project versions (try/catch around parse).
- `toggleFolderCollapsed(projectId, folderId)` and
  `setFolderExpanded(projectId, folderId)`.
- In `selectWorkspace`, after resolving `ws`, if `ws.folderId` is set call
  `get().setFolderExpanded(projectId, ws.folderId)` so the selected row is
  never hidden.

## Grouping utils (`src/utils/workspace-folders.ts`, new)

```ts
export interface FolderGroup { folder: WorkspaceFolder; workspaces: WorkspaceInfo[] }
export interface GroupedWorkspaces { loose: WorkspaceInfo[]; folders: FolderGroup[] }

export function groupWorkspaces(project: Pick<ProjectInfo, "workspaces" | "folders">): GroupedWorkspaces
export function mergeSectionOrder(allPaths: string[], sectionPaths: string[]): string[]
```

- `groupWorkspaces`: skip `hidden` workspaces. A workspace whose `folderId`
  matches a folder goes into that folder's group; everything else (no id, or
  unknown id) goes into `loose`. Preserve `project.workspaces` order inside
  each section. `folders` follows `project.folders` order and **includes
  empty folders** (so a freshly created folder is visible).
- `mergeSectionOrder`: walk `allPaths`; each time you hit a path that is in
  `sectionPaths`, emit the next path from `sectionPaths` instead. Paths in
  `sectionPaths` that are missing from `allPaths` are appended at the end.
  Result always has the same length as the union of the two inputs.

## Tests (`src/utils/workspace-folders.test.ts`, new)

- grouping: hidden excluded; unknown folderId → loose; empty folder present;
  order preserved within sections.
- merge: reorder inside a middle section leaves surrounding paths untouched;
  identity when section order unchanged; unknown section paths appended.

Run `pnpm vitest run src/utils/workspace-folders.test.ts` and `pnpm exec tsc --noEmit -p tsconfig.json && pnpm exec tsc --noEmit -p tsconfig.electron.json`.

## Files to touch
- `src/store/project-store.ts` — types, four actions, collapse state, selectWorkspace hook
- `src/electron.d.ts` — swap inline folder type for the store export
- `src/utils/workspace-folders.ts` — new pure module
- `src/utils/workspace-folders.test.ts` — new tests
