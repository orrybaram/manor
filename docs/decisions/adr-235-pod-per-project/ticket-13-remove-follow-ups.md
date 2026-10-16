---
title: Remove follow-ups — paired-device delete refresh, checkbox reset
status: done
priority: low
assignee: sonnet
blocked_by: [6]
---

# Remove follow-ups — paired-device delete refresh, checkbox reset

Follow-ups from ticket 6 (ADR-235 D6).

- The DELETE route in `electron/routes/projects.ts` (the paired-device HTTP
  path) clears `forProject` through `ProjectManager` but doesn't call
  `backendRegistry.recordChanged` for the cleared hosts. Use
  `ProjectManager.hostsMadeFor(projectId)` before the removal, as
  `projectsRemove` in `electron/bridge/handlers/projects.ts` does, so the host
  list re-sends.
- `RemoveProjectDialog` / `RemoveFromHostDialog` stay mounted, so a checkbox
  unchecked once stays unchecked on the next open. Reset it to checked
  whenever the dialog opens.

## Files to touch
- `electron/routes/projects.ts`
- `src/components/sidebar/RemoveProjectDialog.tsx`, `RemoveFromHostDialog.tsx`
