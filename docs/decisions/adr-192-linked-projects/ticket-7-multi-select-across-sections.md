---
title: Sidebar multi-select works across a group's host sections
status: done
priority: low
assignee: opus
blocked_by: [1]
---

# Sidebar multi-select works across a group's host sections

GitHub issue #250. See ADR-192 §5. This ticket is also blocked on the
ADR-190 sidebar multi-select work being merged.

- The ADR-190 group-tree helpers treat host sections as part of the group's tree.
- Range and toggle selection work across sections.
- Bulk actions run each workspace's action against its own member project and host.
- Cover selection across sections in the sidebar-items tests.

## Files to touch
- `src/utils/sidebar-items.ts`, `src/utils/sidebar-items.test.ts`
- The ADR-190 selection store and hooks
- `src/components/sidebar/ProjectGroupItem.tsx`

## Implementation notes

- **Scope.** The selection store (`sidebar-selection-store.ts`) is keyed by
  a scope id rather than a project id: the group id for a linked group's
  sections, the project id for a lone project. `ProjectGroupItem` builds the
  group's `SelectionScope` (each section's item tree, collapsed folders and
  collapsed state) and hands it to every section's `ProjectItem`.
- **Keys.** Entries are `selectionKey(projectId, path)`, not bare paths, so
  the same checkout path on two hosts is two rows, and every entry names the
  member project that owns it. The member project id is used rather than the
  ADR-191 `workspaceKey`, because routing a bulk action needs the project.
  Within a group, one project per host makes the two equivalent.
- **Order.** `visibleSelectionKeys` concatenates each open section's visible
  rows in section order, so a shift-click range crosses section boundaries.
  `selectionBySection` splits a selection back into per-member shares, in
  tree order, and drops stale keys.
- **Bulk actions.** Hide, delete and "Remove from Folder" run once per member
  project, against that project's own rows. Deletes queue up within a member
  project (one repo) and run independently across members. The "deleting"
  dimming moved into a shared `deleting-workspaces-store.ts`, so rows dim in
  every section a bulk delete touches.
- **Move to Folder.** Folders belong to one member project. When the
  selection spans sections, the bulk menu shows "Move to Folder" disabled,
  with the hint "Selection spans hosts". "New Folder…" lives in that submenu
  and is disabled with it. A selection within one section works as before.
- **Drag.** A group drag moves only the grabbed section's share of the
  selection. Rows selected in other sections stay put, so no workspace moves
  between member projects.
