---
title: Shared settings live on the project group
status: done
priority: medium
assignee: opus
blocked_by: [1]
---

# Shared settings live on the project group

GitHub issue #245. See ADR-192 §5.

- `PersistedProjectGroup` gains optional shared settings: `color`, `agentCommand` and `linearAssociations`. The name is already on the group.
- Reads resolve group first, then project. `buildProjectInfo` returns the resolved values for a grouped project.
- Add a ProjectManager `updateGroup(groupId, updates)`. Writes from the shared section go to the group.
- `unlinkProject` copies the group's shared values onto the project that leaves.
- Project settings for a grouped project show a shared section (the group) and one section per member host (path, worktree root, setup and teardown scripts, commands). Link and Unlink are available here as well.
- Tests go through the ProjectManager seam: resolution order and the copy on unlink.

## Files to touch
- `electron/projects/types.ts`, `project-groups.ts`, `project-info.ts`, `project-manager.ts`
- `electron/ipc/projects.ts`, `electron/preload.ts`, `src/electron.d.ts`, `src/store/project-store.ts`
- `src/components/settings/` (the project settings page)
