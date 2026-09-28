---
title: Add "Choose local folder…" when linking a remote project
status: in-progress
priority: medium
assignee: sonnet
blocked_by: [2, 3]
---

# Add "Choose local folder…" when linking a remote project

ADR-193 §4.

- `src/store/project-store.ts`:
  - `addProject` returns the created `ProjectInfo` (update its type; callers
    that ignore the result are fine).
  - New action `linkLocalFolder(projectId: string): Promise<void>`:
    open `window.electronAPI.dialog.openDirectory()`; cancel → return. If a
    local project (`!isRemoteHost(hostId)`) already has that path, link it
    with `projectId`. Otherwise `projects.add(<projectId's group name or
    project name>, path)`, append it to state like `addProject` does but
    WITHOUT calling `offerLinkSuggestions`, then `linkProjects(projectId,
    newId)` (check argument order so the remote project's group/name wins).
    Errors → error toast via the toast store with the message.
- Eligibility helper (pure, in `src/lib/project-groups.ts` or next to
  `linkChoices` in `src/utils/sidebar-items.ts`): `canLinkLocalFolder(project,
  projects)` = project is on a remote host and its group has no local member.
  Unit test it.
- `src/components/sidebar/ProjectItem.tsx`: in the "Link with…" submenu, when
  eligible, add a separator (if there are other choices) and a
  "Choose local folder…" item calling `linkLocalFolder(project.id)`. The
  submenu trigger is disabled only when there are no choices AND it isn't
  eligible.
- `src/components/settings/ProjectLinksSection.tsx`: when eligible, a
  secondary `<Button>` "Choose local folder…" beside the Link with select.

## Files to touch
- `src/store/project-store.ts`
- `src/lib/project-groups.ts` or `src/utils/sidebar-items.ts` (+ test)
- `src/components/sidebar/ProjectItem.tsx`
- `src/components/settings/ProjectLinksSection.tsx`
