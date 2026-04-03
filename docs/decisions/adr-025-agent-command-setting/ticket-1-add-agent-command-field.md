---
title: Add agentCommand field to persistence and store
status: todo
priority: high
assignee: sonnet
blocked_by: []
---

# Add agentCommand field to persistence and store

Add `agentCommand` as a per-project setting that persists to disk and is available in the renderer.

## Files to touch
- `electron/persistence.ts` — add `agentCommand: string | null` to `PersistedProject` and `ProjectInfo`. Default to `null` in `buildProjectInfo`. Include in `addProject` default.
- `src/store/project-store.ts` — add `agentCommand` to `ProjectInfo` interface and `ProjectUpdatableFields` Pick list.
