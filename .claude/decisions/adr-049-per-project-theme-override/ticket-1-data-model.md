---
title: Add themeName to project data model
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Add themeName to project data model

Add `themeName: string | null` to the project model across the data layer.

## Files to touch

- `electron/persistence.ts`
  - Add `themeName?: string | null` to `PersistedProject` interface
  - Add `"themeName"` to `ProjectUpdatableFields` Pick
  - Add `themeName` to `ProjectInfo` interface
  - In `addProject()`, set `themeName: null` in the new project object
  - In `buildProjectInfo()`, include `themeName: p.themeName ?? null` in the returned object

- `src/store/project-store.ts`
  - Add `themeName: string | null` to `ProjectInfo` interface
  - Add `"themeName"` to `ProjectUpdatableFields` Pick

No IPC changes needed — the existing `projects:update` handler uses `Object.assign` and will automatically persist the new field.
