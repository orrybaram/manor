---
title: "Show all hosts" in New Workspace and Project Settings
status: in-progress
priority: medium
assignee: sonnet
blocked_by: []
---

# "Show all hosts" in New Workspace and Project Settings

Decided 2026-10-15 after review. `NewWorkspaceDialog` (cloneTargets /
cloneSourceTargets) and `ProjectHostSection` / `ProjectSetUpOnSection` call
`transferTargets` and hide other projects' pods with no way back. Add the same
"Show all hosts" toggle the Set up on menu has (`hasHiddenPods`, the
`showAllHosts` option), shown only when something is hidden. Use `Button
variant="link"` as Add Project does.

Tests: whatever pure logic you add. The rendering follows the existing
component test setup where one exists for these files.

## Files to touch
- `src/components/sidebar/NewWorkspaceDialog/NewWorkspaceDialog.tsx`, `HostPicker.tsx`
- `src/components/settings/**/ProjectHostSection.tsx`, `ProjectSetUpOnSection.tsx` (find them)
