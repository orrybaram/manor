---
title: Group tree helpers in sidebar-items
status: todo
priority: high
assignee: sonnet
blocked_by: []
---

# Group tree helpers in sidebar-items

Add these pure functions to `src/utils/sidebar-items.ts` (see ADR-190 §1–3), next to the existing `placeInFolder` / `placeAfterFolder` / `applyDrop`, reusing the internal `removeItem` / `insertItem` / `locate` / `findFolder` helpers:

- `visibleWorkspacePaths(items, collapsedFolderIds): string[]` returns workspace paths in depth-first tree order, skipping the contents of collapsed folders (at any depth).
- `placeManyInFolder(items, keys, folderId)` appends each key to the folder in the given order. It skips keys that are not in the tree, and refuses folder-into-own-subtree exactly like `placeInFolder`.
- `placeManyAfterFolders(items, keys)` moves each key that is inside a folder to sit right after its own enclosing folder, keeping the keys' relative order when several share a folder. Loose keys are untouched.
- `applyGroupDrop(items, sourceKey, groupKeys, target, rows)`:
  - If `groupKeys` has ≤1 entry (or only `sourceKey`), return `applyDrop(items, sourceKey, target, rows)` unchanged.
  - For an `into` target, call `placeManyInFolder(items, groupKeysInTreeOrder, folderId)`.
  - For a `slot` target, `target.rowIndex` indexes `rows` minus the source row (same semantic as `applyDrop`). Take `pred = rest[rowIndex - 1]`. While `pred` is a group key, step back.
  - Remove every group item from the tree.
  - If there is no `pred`, insert the block at the top level at index 0.
  - If `pred` is an expanded folder (one that appears as some row's `parentFolderId`), insert the block as that folder's first children.
  - Otherwise insert the block right after `pred` in `pred`'s parent.
  - The block is the group in its original tree order.

Add thorough tests in `src/utils/sidebar-items.test.ts`:

- range across a folder boundary, and across a collapsed folder
- many into folder
- many out of mixed folders
- group slot drop above, below, into an expanded folder header slot, and out of a folder to the top level
- predecessor inside the group
- a group of one matching `applyDrop`

## Files to touch
- `src/utils/sidebar-items.ts`
- `src/utils/sidebar-items.test.ts`
