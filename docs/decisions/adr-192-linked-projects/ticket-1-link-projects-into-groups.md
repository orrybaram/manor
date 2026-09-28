---
title: Link two projects into a group shown as one sidebar entry
status: done
priority: high
assignee: opus
blocked_by: []
---

# Link two projects into a group shown as one sidebar entry

GitHub issue #244. See ADR-192 §1–§4. This is the tracer bullet.

- `electron/projects/types.ts`: `PersistedProjectGroup` and `ProjectGroupInfo`. Add `groups?` to `PersistedState` and `group: ProjectGroupInfo | null` to `ProjectInfo`.
- New `electron/projects/project-groups.ts` holds the invariants (at most one group per project, at most one member per host, at least two members), load-time normalization, link, unlink, forget-on-remove, and the host-move guard.
- `state-store.ts` normalizes groups on load and omits an empty list on write.
- `project-manager.ts` gets `linkProjects` and `unlinkProject`, puts `group` into every `ProjectInfo`, and makes `removeProject` forget the project.
- `host-move.ts` refuses a move onto a host that another group member already has.
- IPC `projects:link` and `projects:unlink`, plus preload and `electron.d.ts`.
- Renderer: add `group` to `ProjectInfo`, and add the `linkProjects` and `unlinkProject` store actions.
- `src/utils/sidebar-items.ts`: `buildTopLevelEntries`, `expandTopLevelOrder`, and `topLevelKeys`.
- Sidebar: render entries with a new `ProjectGroupItem`, give `ProjectItem` a `variant="section"`, and add "Link with…" and "Unlink" to the project context menu.
- Tests: ProjectManager with fake hosts (link, unlink, one per host, persistence round trip) and sidebar-items (grouped rendering and ordering).

## Files to touch
- `electron/projects/types.ts`, `project-groups.ts` (new), `state-store.ts`, `project-manager.ts`, `project-info.ts`, `host-move.ts`
- `electron/projects/project-groups.test.ts` (new)
- `electron/ipc/projects.ts`, `electron/preload.ts`, `src/electron.d.ts`
- `src/store/project-store.ts`
- `src/utils/sidebar-items.ts`, `src/utils/sidebar-items.test.ts`
- `src/components/sidebar/Sidebar/Sidebar.tsx`, `ProjectItem.tsx`, `ProjectItem.module.css`, `ProjectGroupItem.tsx` (new)
