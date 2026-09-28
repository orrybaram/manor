---
title: "\"Clone onto another host…\" from the host picker, linked automatically"
status: todo
priority: medium
assignee: sonnet
blocked_by: [3]
---

# "Clone onto another host…" from the host picker, linked automatically

GitHub issue #247. See ADR-192 §5.

- The picker offers "Clone onto another host…", listing only hosts with no member in the group.
- It launches the existing clone flow (`useHostCloneFlow` / `CloneToHostDialog` / `addRemoteProject`).
- When the clone succeeds, call `linkProjects(newProjectId, groupMemberId)` and continue the dialog with that host selected.
- A cancelled or failed clone leaves the group unchanged.
- A test goes through the project-store seam: linking after a clone.

## Files to touch
- `src/components/sidebar/NewWorkspaceDialog/NewWorkspaceDialog.tsx`
- `src/store/project-store.ts`
