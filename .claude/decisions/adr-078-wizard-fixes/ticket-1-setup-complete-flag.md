---
title: Add setupComplete flag and guard wizard display
status: done
priority: critical
assignee: sonnet
blocked_by: []
---

# Add setupComplete flag and guard wizard display

The wizard should only appear once per project — right after initial creation.

## Implementation

1. **Add `setupComplete` to ProjectInfo** in `src/store/project-store.ts`:
   - Add `setupComplete: boolean` to the `ProjectInfo` interface
   - Existing projects loaded from backend won't have this field — default to `true` (so wizard doesn't re-show for existing projects)

2. **Backend: add field to project schema** — check `electron/projects.ts` or equivalent IPC handlers. The `add` method should set `setupComplete: false` for new projects. The `update` method should accept `setupComplete`.

3. **Guard wizard display in App.tsx** (line ~439):
   - Change condition from `wizardOpen && wizardProjectId` to also check `!project.setupComplete`
   - When `closeWizard` is called, also call `updateProject(projectId, { setupComplete: true })`

4. **Close wizard on workspace switch**: If the user switches away from the project while the wizard is open, close it automatically.

## Files to touch
- `src/store/project-store.ts` — add `setupComplete` to `ProjectInfo` and `ProjectUpdatableFields`
- `src/App.tsx` — guard wizard display, persist setupComplete on close
- `electron/projects.ts` (or wherever project schema is defined) — add `setupComplete` field with default
- `src/electron.d.ts` — update ProjectInfo type if defined there
