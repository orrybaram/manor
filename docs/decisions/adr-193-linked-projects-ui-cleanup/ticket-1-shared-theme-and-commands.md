---
title: Share theme and commands across a linked group
status: todo
priority: high
assignee: sonnet
blocked_by: []
---

# Share theme and commands across a linked group

ADR-193 §1. Make `themeName` and `commands` group-level shared settings, like
`color` and `agentCommand` already are.

- `electron/projects/types.ts`: add `themeName` and `commands` to
  `GroupSharedFields`, and optional `themeName?: string | null`,
  `commands?: CustomCommand[]` to `PersistedProjectGroup`.
- `electron/projects/project-groups.ts`:
  - `resolveShared`: `themeName` like `color` (group null is a value, absent
    falls through); `commands` like `linearAssociations`.
  - `sharedFrom`: type-check them from disk (`commands` must be an array of
    `{id,name,command}` strings; drop malformed entries).
  - `copySharedOnto`: copy both when present on the group.
  - `updateGroup` (and whatever validation `GroupUpdatableFields` goes
    through in `electron/ipc/projects.ts`): accept both.
- Wherever `updateProject` on a grouped project is routed to the group for
  shared fields (check `project-manager.ts` `updateProject` and the renderer
  `updateProject` / `updateGroup` in `src/store/project-store.ts`), include
  `themeName` and `commands` so edits from the UI land on the group.
- `buildProjectInfo` (`electron/projects/project-info.ts`) must expose the
  resolved `themeName` / `commands` for grouped projects.
- Tests: extend `electron/projects/__tests__/` group tests for resolve,
  load normalization, update and copy-on-unlink of the two new fields.

## Files to touch
- `electron/projects/types.ts`
- `electron/projects/project-groups.ts`
- `electron/projects/project-info.ts`
- `electron/projects/project-manager.ts` (if shared-field routing lives there)
- `electron/ipc/projects.ts` (validation of group update fields)
- `src/store/project-store.ts` (if shared-field routing lives there)
- `electron/projects/__tests__/*group*` tests
