---
title: Nested folders — view model, store, menu handlers
status: todo
priority: high
assignee: opus
blocked_by: [1]
---

# Nested folders — view model, store, menu handlers

Turn `SidebarItem` into a real tree and make the store persist folder parents.
No component or drag-hook changes here (ticket 4) — but the renderer must
still typecheck, so adjust call sites mechanically where the shape change
forces it.

## `src/utils/sidebar-items.ts`

```ts
export type SidebarItem =
  | { kind: "workspace"; ws: WorkspaceInfo }
  | { kind: "folder"; folder: WorkspaceFolder; children: SidebarItem[] };
```

- `buildSidebarItems(project)` — recursive. A folder's children are the
  visible workspaces whose `folderId` is that folder plus the folders whose
  `parentId` is that folder, ordered by their first index in `sidebarOrder`,
  with anything the order forgot appended. Keep the existing defensive tail:
  an entry whose parent chain does not resolve (dangling or cyclic
  `parentId`) is emitted at the top level rather than dropped. Empty folders
  are still kept.
- `Row` gains `depth: number`. `flattenRows(items, collapsedIds, dragging)`
  recurses into expanded folders. For a **folder** drag it now emits other
  folders' header rows as well (a folder can be dropped into a folder) but
  skips the dragged folder's own subtree entirely. For a **workspace** drag,
  behaviour is as today, one level deeper.
- `applyDrop(items, sourceKey, target, rows)` — same contract, now recursive.
  New rule: a folder dropped into itself or any descendant is a no-op
  (return `items` unchanged). `{ type: "into", folderId }` accepts a folder
  source and appends it as the last child. The predecessor rule that decides
  a slot drop's parent is unchanged in spirit — the predecessor row's
  `parentFolderId` (or the folder header itself, when expanded) is the new
  parent, at any depth.
- `serializeOrder(items, project)` — depth-first through `children`.
- `membershipOf(items)` — unchanged signature (workspace path → folder id or
  null), now walking the tree.
- `folderParentsOf(items): Map<string, string | null>` — new, folder id →
  parent id.
- `descendantWorkspaces(item): WorkspaceInfo[]` — new, a folder's whole
  subtree of workspaces, used by the header's count and aggregate agent dot.
- `isFolderDescendant(items, folderId, candidateId): boolean` — new, the
  renderer-side twin of the main-process guard.
- `placeInFolder`, `placeAfterFolder`, `insertFolderBefore` — accept a
  workspace path *or* a folder id as the moved/anchor key, so the same
  helpers serve folder moves.

Rewrite `src/utils/sidebar-items.test.ts` against the new shape and add cases
for: nested build from `sidebarOrder` + `parentId`; drop a folder into a
folder; the self/descendant no-op; `serializeOrder` round-tripping a
two-level tree; `folderParentsOf`; `descendantWorkspaces` across two levels.

## `src/store/project-store.ts`

- `WorkspaceFolder` gains `parentId: string | null`.
- `applySidebarChange(projectId, next)` — also diff folder parents via
  `folderParentsOf` and call `window.electronAPI.projects.setFolderParent`
  for each change, alongside the existing `setWorkspaceFolder` calls, before
  `reorderWorkspaces`. Patch `folders` optimistically the way `workspaces` is
  already patched.
- `createWorkspaceFolder(projectId, name, anchorKey?, parentId?)` — pass
  `parentId` through to the IPC and into the optimistic `folders` entry.
- `deleteWorkspaceFolder` — mirror main's promotion rule in the optimistic
  update: child folders and member workspaces take the deleted folder's
  parent, and `spliceFolderOutOfOrder` receives child folder ids alongside
  member paths.

## Call sites that must follow the shape change

- `src/lib/menu-handlers.ts` — the flatten at the "Home first, then each
  project's visible workspaces with folder members flattened" comment now
  recurses through `children`.
- `src/hooks/useMenuContextSync.ts` — same flatten; the `folders` payload it
  sends to the native menu gains `parentId`, and folder names in the "Move to
  Folder" menu become full paths (`epic / api`) so nested folders are
  distinguishable. Update `src/hooks/__tests__/useMenuContextSync.test.ts` and
  `src/lib/__tests__/menu-handlers.test.ts` accordingly.
- `src/components/sidebar/ProjectItem.tsx` and `FolderItem.tsx` — make them
  compile against `children` with the minimum edit (e.g. render
  `item.children` where `item.workspaces` was read, count via
  `descendantWorkspaces`). Ticket 4 does the real UI work; do not add nesting
  affordances here.

## Files to touch
- `src/utils/sidebar-items.ts` — tree model and helpers
- `src/utils/sidebar-items.test.ts` — rewritten for the tree
- `src/store/project-store.ts` — `parentId`, parent diffing, promotion on delete
- `src/lib/menu-handlers.ts` — recursive flatten
- `src/hooks/useMenuContextSync.ts` — recursive flatten, `parentId`, path labels
- `src/lib/__tests__/menu-handlers.test.ts`, `src/hooks/__tests__/useMenuContextSync.test.ts` — follow the shape
- `src/components/sidebar/ProjectItem.tsx`, `src/components/sidebar/FolderItem.tsx` — mechanical compile fixes only

## Verify
`pnpm test:unit`, `pnpm lint` and `pnpm build` pass.
