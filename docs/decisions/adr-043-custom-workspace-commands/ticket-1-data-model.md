---
title: Add commands field to project data model
status: todo
priority: critical
assignee: sonnet
blocked_by: []
---

# Add commands field to project data model

Add the `CustomCommand` type and `commands` field across the data model layer.

## Files to touch

- `electron/persistence.ts` — Add `CustomCommand` interface (id, name, command). Add `commands?: CustomCommand[]` to `PersistedProject`. Add `commands` to `ProjectUpdatableFields`. Add `commands: CustomCommand[]` to `ProjectInfo`. Update `buildProjectInfo()` to include `commands: p.commands ?? []`. Update `addProject()` to initialize `commands: []`.
- `src/store/project-store.ts` — Add `CustomCommand` interface. Add `commands: CustomCommand[]` to `ProjectInfo`. Add `"commands"` to `ProjectUpdatableFields` Pick union.
- `src/electron.d.ts` — No changes needed (types come from store imports)
