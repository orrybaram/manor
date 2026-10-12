---
title: New-agent target model and prompt-derived worktree names
status: done
priority: high
assignee: sonnet
blocked_by: [1]
---

# New-agent target model and prompt-derived worktree names

ADR-222 D2 + D3. Pure functions, fully unit tested. No React, no store access.

## `src/components/phone/NewAgent/new-agent-target.ts`
Keep the `NewAgentTarget` type from ticket 1 and add:

- `seedTarget(projects, activeKey: WorkspaceKey | null, hosts)` → active workspace's project + path (`find` from `src/lib/workspace-directory.ts`), `newWorktree: false`; else first entry of `buildTopLevelEntries(projects)` (`src/utils/sidebar-items.ts:873`) — a group resolves through `startingMemberId` (`src/lib/workspace-host-choices.ts`) — at its main path (`project.path`); `null` when no projects.
- `projectChoices(projects)` → one entry per top-level entry: `{ id, name, color, groupId? }` (for a group, `id` is the group id and name/color from the group / first member).
- `hostChoices(target, projects, hosts)` → `workspaceHostChoices(project, projects, hosts)`; `null` means "not linked, hide the chip".
- `workspaceChoices(target, projects)` → main first (`path: project.path`, label "main" or the default branch), then non-hidden workspaces in project order: `{ path, label, branch, isMain }`. Label = `workspace.name ?? branch`.
- `selectProject(target, idOrGroupId, projects, hosts)` → member via `startingMemberId` for groups; workspace resets to main; keeps `newWorktree`.
- `selectHost(target, memberProjectId, projects)` → switch member; keep a workspace on the same branch if the new member has one (`branchesEqual`), else main.
- `selectWorkspace(target, path)`; `toggleWorktree(target)`.
- `resolveTarget(target, projects)` → `{ project, workspace, hostId }` or `null` if the target went stale (project/workspace removed); callers then re-seed.

## `src/utils/branch-name.ts`
- `worktreeNameFromPrompt(prompt: string, taken: ReadonlySet<string>): string` — `toDirSlug` of the first ~6 words, capped at 40 chars on a word/dash boundary, fallback `"agent"`, then `-2`, `-3`… until not in `taken`. Callers build `taken` from the project's workspace names, branches and path basenames.

## Tests
- `src/components/phone/NewAgent/__tests__/new-agent-target.test.ts` — seeding (active ws, Home, group, empty), group collapse, host chip null for unlinked, host switch keeps same-branch workspace, stale resolve.
- `src/utils/__tests__/branch-name.test.ts` (extend or create) — slugging, cap, fallback, suffixing.

Follow the shapes used by `src/store/__tests__/project-store-new-workspace-host.test.ts` for building projects/hosts fixtures.

## Files to touch
- `src/components/phone/NewAgent/new-agent-target.ts`
- `src/utils/branch-name.ts`
- tests above
