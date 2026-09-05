---
title: Single-list sidebar drag with drop-into-folder
status: in-progress
priority: high
assignee: opus
blocked_by: [2]
---

# Single-list sidebar drag with drop-into-folder

Replace the per-section drag with one project-level drag over the flattened
row model, render folders inline in order, and add the drop-into-folder
gesture. Read `docs/decisions/adr-167-sidebar-drag-into-folders/index.md`
and `src/utils/sidebar-items.ts` first.

## 1. `src/hooks/useSidebarDrag.ts` (new)

Start from `src/hooks/useWorkspaceDrag.ts` (then delete it). Contract:

```ts
export function useSidebarDrag(opts: {
  items: SidebarItem[];
  collapsedFolderIds: Set<string>;
  disabled: boolean;                          // e.g. while a rename input is open
  onDrop: (sourceKey: string, target: DropTarget, rows: Row[]) => void;
}): {
  dragKey: string | null;
  intoFolderId: string | null;
  justDragged: React.RefObject<boolean>;
  rowRefs: React.RefObject<Map<string, HTMLElement>>;   // key → element to measure/transform
  handleDragStart: (key: string, kind: "workspace" | "folder", e: React.PointerEvent) => void;
  getTransformStyle: (key: string) => React.CSSProperties | undefined;
}
```

- On `handleDragStart`, compute `rows = flattenRows(items, collapsedFolderIds, kind)`
  and the source index. Measure each row's height from `rowRefs.get(row.key)`
  (`getBoundingClientRect().height + 8`). **Registration rule:** a workspace
  row registers its row element under its path; a folder registers its
  *block* element (`.folder`) under `folder.id` and its header under
  `header:${folder.id}`. For folder-kind drags measure blocks; for
  workspace-kind drags measure headers for folder rows.
- Keep the pointer-capture, 4px activation threshold, `dragCount` overlay
  bookkeeping, and cumulative-height drop search from the old hook, operating
  on `rows`.
- **Into detection** for workspace drags: on each move, find any folder row
  whose header rect (measured at drag start, adjusted by the running shift
  the transforms apply — simpler: use the *unshifted* start rects, they are
  what the pointer is over since headers do not move while `into` is
  active) contains the pointer Y within its middle 50%. If found and the
  folder is not the source's current parent-with-single-member edge case
  (ignore that; just allow), set `intoFolderId` and set the drop index back
  to the source index so no neighbour shifts. Otherwise `intoFolderId = null`
  and slot mode as usual.
- On release: if a drag activated, call
  `onDrop(sourceKey, intoFolderId ? { type: "into", folderId } : { type: "slot", rowIndex: finalDrop }, rows)`
  only when something changed (`intoFolderId` set, or `finalDrop !== sourceIndex`).
  Set `justDragged` for one frame exactly like the old hook.
- `getTransformStyle(key)` mirrors the old logic but looks up indices through
  the current `rows` (stored in a ref during the drag). When `intoFolderId`
  is set, only the dragged row translates.

## 2. `src/components/sidebar/ProjectItem.tsx`

- `const items = useMemo(() => buildSidebarItems({ workspaces, folders, sidebarOrder }), [...])`
  (destructure from `project` first — the react-compiler lint rule rejects
  member-expression deps).
- One `useSidebarDrag` per project. `disabled = editingPath !== null || folderEditing`.
  `onDrop` → `applySidebarChange(project.id, applyDrop(items, sourceKey, target, rows))`.
- Render `items` in order inside a single `<div className={styles.workspaces}>`:
  workspace item → the existing `renderWorkspace` body (now taking `key`
  and the hook's `getTransformStyle(key)`, `rowRefs`, `handleDragStart(ws.path, "workspace", e)`,
  `isDragging = dragKey === ws.path`); folder item → `<FolderItem>` with
  members rendered by the same `renderWorkspace`.
- Remove the temporary shim from ticket 2 and the `WorkspaceList` usage.
  Global index is still `project.workspaces.indexOf(ws)` for
  `onSelectWorkspace`/`onHideWorkspace`/`onOpenDiff`.
- Menu actions route through the tree: *Move to Folder ▸ X* →
  `applySidebarChange(id, placeInFolder(items, ws.path, X))`; *Remove from
  Folder* → `placeAfterFolder`; *New Folder…* from a row →
  `createWorkspaceFolder(project.id, name, ws.path)`; from the project header
  → no anchor.

## 3. `src/components/sidebar/FolderItem.tsx`

New props: `dropTarget: boolean`, `isDragging: boolean`,
`onDragStart: (e: React.PointerEvent) => void`,
`registerBlock: (el: HTMLElement | null) => void`,
`registerHeader: (el: HTMLElement | null) => void`,
`style?: React.CSSProperties` (the transform), `justDragged: React.RefObject<boolean>`.

- Block `div.folder` gets `ref={registerBlock}`, `style`, and
  `styles.folderDragging` when `isDragging`.
- Header gets `ref={registerHeader}`, `onPointerDown={onDragStart}`
  (`touchAction: "none"`), `styles.folderDropTarget` when `dropTarget`, and
  its click handler toggles collapse only if `!justDragged.current && !editing`.
- Expose whether the inline rename is open via an `onEditingChange(boolean)`
  prop so `ProjectItem` can disable drag while a folder is being renamed.

## 4. CSS (`ProjectItem.module.css`)

- `.folderDropTarget` — `background: var(--surface); box-shadow: inset 0 0 0 1px var(--project-color, var(--accent)); border-radius: 4px;`
- `.folderDragging` — same look as `.workspaceDragging` (opacity .7,
  surface background, shadow, z-index 10).
- `.folder` keeps `margin-top: 8px`? No — it now lives inside `.workspaces`
  which already has `gap: 8px`. Remove the margin so the 8px measurement in
  the hook matches the layout.

## 5. Delete

- `src/hooks/useWorkspaceDrag.ts`
- `src/components/sidebar/WorkspaceList.tsx`

`pnpm knip:ci` must be clean afterwards.

## 6. Verify

- `pnpm exec tsc --noEmit -p tsconfig.json && pnpm exec tsc --noEmit -p tsconfig.electron.json` (no NEW errors), `pnpm lint` on touched files (one pre-existing error at the `deletingPaths` effect is known), `pnpm test`.
- Reason through and note in your report: loose→into via header; loose→slot
  after header of an expanded folder; member dragged to the very top becomes
  loose; folder dragged above `local`; collapse state unaffected by drags;
  rename input blocks drag.

## Files to touch
- `src/hooks/useSidebarDrag.ts` — new hook
- `src/components/sidebar/ProjectItem.tsx` — items rendering, one drag, menu routing
- `src/components/sidebar/FolderItem.tsx` — drag/drop props
- `src/components/sidebar/ProjectItem.module.css` — drop target and dragging styles, margin removal
- `src/hooks/useWorkspaceDrag.ts`, `src/components/sidebar/WorkspaceList.tsx` — delete
