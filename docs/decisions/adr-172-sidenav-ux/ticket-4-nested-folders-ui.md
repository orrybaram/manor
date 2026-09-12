---
title: Nested folders — drag, rendering, folder-in-folder creation
status: done
priority: high
assignee: opus
blocked_by: [3]
---

# Nested folders — drag, rendering, folder-in-folder creation

Make nesting visible and reachable: render the tree, drag folders into
folders, create a folder inside a folder.

## `src/hooks/useSidebarDrag.ts`

- Rows carry `depth`; heights are still measured per row at drag start.
- **Fix the double-counted nested header (left by ticket 3).** `elementFor`
  resolves a folder row to `rowRefs.get(row.key)` — the whole `.folder` block —
  whenever the drag kind is `"folder"`. Now that a folder drag also emits
  *nested* folders' header rows, a nested header's height is counted twice:
  once as its own row, once inside its ancestor's block. Only the top-level
  rows of a folder drag may measure the block; a row at `depth > 0` must
  measure `headerRefKey(row.key)`. This only bites a project that actually has
  nested folders, so there is no flat-tree regression to chase — but it must
  land before nesting is reachable from the UI.
- Use `Row.depth` to indent the drop indicator so the insertion point reads at
  the depth it will land at.
- **Folder drags gain into-detection.** Today `headerRects` is only built for
  `kind === "workspace"`. Build it for folder drags too, skipping the dragged
  folder's own header and every header inside its subtree (`flattenRows`
  already omits that subtree — use the row list, do not re-derive it).
- The existing skip for "a member's own folder header" stays, and gets a
  sibling for folders: skip the header of the folder the dragged folder is
  already a direct child of, since dropping there would change nothing.
- `getTransformStyle` is unchanged in shape; a folder block still moves whole.
- Leave `INTO_BUFFER` / `INTO_STICKY` as they are.

## `src/components/sidebar/FolderItem.tsx`

- New props: `depth: number`, `onNewSubfolder: () => void`. `workspaces`
  becomes the *subtree* workspaces (from `descendantWorkspaces`) for the count
  and the collapsed aggregate dot; the rendered rows come from `children`.
- Context menu gains **New Folder Inside…** under **New Workspace…**, calling
  `onNewSubfolder`.
- Indent the body per depth, capped: `--folder-depth: min(depth, 4)` as an
  inline CSS custom property, consumed by `.folderBody` in
  `ProjectItem.module.css`. A sidebar is 160–400px wide; past four levels the
  indent stops growing so labels stay readable.
- Keep the existing scroll-into-view-on-expand and drop-target highlight.

## `src/components/sidebar/ProjectItem.tsx`

- Render the tree recursively: a local `renderItem(item, depth)` that returns
  either `renderWorkspace(item.ws)` or a `FolderItem` whose children are
  `item.children.map((child) => renderItem(child, depth + 1))`.
- `NewFolderDialog` already exists; give it a parent. Track
  `newFolderParentId: string | null` alongside the existing
  `pendingMovePath`, set it from **New Folder Inside…**, clear it on close,
  and pass it to `createWorkspaceFolder`. The project header's **New Folder…**
  keeps passing `null`.
- **"New Folder…" from a row inside a folder creates it inside that folder.**
  Ticket 3 left `insertFolderBefore` claiming the anchor's *top-level* slot,
  which was right for flat folders and is now wrong: picking "New Folder…" on
  a workspace nested in `epic` should produce `epic / new-folder` holding that
  workspace, not a sibling of `epic`. Pass the anchor's current
  `folderId` as the new folder's `parentId` and give `insertFolderBefore` the
  anchor's slot *within its parent*. Cover it in `sidebar-items.test.ts`.
- The workspace context menu's **Move to Folder** submenu lists every folder
  in the project by full path (`epic / api`), built from
  `buildSidebarItems`/`folderParentsOf` rather than the flat `project.folders`
  array order, so the list reads as a tree.
- `containsSelected` for a folder header now means the selected workspace is
  anywhere in that folder's subtree.

## `src/components/sidebar/ProjectItem.module.css`

- `.folderBody` indent driven by `--folder-depth`.
- Nothing else changes; reuse the existing folder header, drop-target and
  member styles at every depth.

## Manual check (state it in your commit body)

Create a folder inside a folder, drag a workspace into the inner one, drag the
inner folder out to the top level, drag a folder onto its own child (must be a
no-op), collapse the outer folder and confirm the count and agent dot cover
the whole subtree.

## Files to touch
- `src/hooks/useSidebarDrag.ts` — folder into-detection, nested-header measurement fix, depth
- `src/utils/sidebar-items.ts` + `src/utils/sidebar-items.test.ts` — `insertFolderBefore` parent-aware slot
- `src/components/sidebar/FolderItem.tsx` — depth, subtree count, New Folder Inside…
- `src/components/sidebar/ProjectItem.tsx` — recursive render, parented New Folder, folder-path submenu
- `src/components/sidebar/ProjectItem.module.css` — depth indent

## Verify
`pnpm test:unit`, `pnpm lint` and `pnpm build` pass.
