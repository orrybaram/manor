---
title: Suggest links when two projects share an origin URL
status: todo
priority: medium
assignee: opus
blocked_by: [1]
---

# Suggest links when two projects share an origin URL

GitHub issue #248. See ADR-192 §5.

- `PersistedProjectGroup` gains `originUrl?`, the URL normalized with the existing GitHub remote-URL parsing (`normalizeOriginUrl` / `ghRepoFromRemoteUrl`).
- Add a ProjectManager `suggestLinks(projectId)` that returns candidates on other hosts whose normalized `origin` matches. Use the group's stored URL when a member's host is offline. It only returns candidates and never links.
- After adding or cloning a project with a matching `origin`, show a suggestion the user can accept or dismiss. Persist dismissed pairs so they aren't suggested again.
- Forks and other non-matching remotes are never suggested.
- Tests go through the ProjectManager seam: suggestions and non-suggestions.

## Files to touch
- `electron/projects/types.ts`, `project-groups.ts`, `project-manager.ts`
- `electron/ipc/projects.ts`, `electron/preload.ts`, `src/electron.d.ts`, `src/store/project-store.ts`
- The add-project and clone flows in `src/components/`
