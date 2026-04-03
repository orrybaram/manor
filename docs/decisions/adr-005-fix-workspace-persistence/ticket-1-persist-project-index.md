---
title: Persist selectedProjectIndex in selectWorkspace
status: done
priority: high
assignee: haiku
blocked_by: []
---

# Persist selectedProjectIndex in selectWorkspace

Update `ProjectManager.selectWorkspace()` in `electron/persistence.ts` to also update `this.state.selectedProjectIndex` to the index of the project whose workspace is being selected.

## Files to touch
- `electron/persistence.ts` — In `selectWorkspace()`, find the project's index in `this.state.projects` and set `this.state.selectedProjectIndex` to it before calling `saveState()`.
