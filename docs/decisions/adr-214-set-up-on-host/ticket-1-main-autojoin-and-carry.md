---
title: Main — auto-join same-origin projects and carry main workspace metadata
status: in-progress
priority: high
assignee: opus
blocked_by: []
---

# Main: auto-join same-origin projects and carry main workspace metadata

Implement the main-process parts of ADR-214 (`index.md`, sections "Auto-join same-origin projects" and "Carry the main workspace's metadata"). Read ADR-213 and `electron/projects/{origin-links,project-groups,host-transfer,project-manager}.ts` first.

## Steps
1. **Auto-join:** add `ProjectManager.autoJoin(): Promise<Array<{ joinedId: string; intoId: string }>>`.
   - Run the same `suggest` that link suggestions use today, over every ungrouped project. Find the current entry point that `projects.suggestLinks` calls.
   - Call `linkProjects(newcomer, existing)` for each pair, so the existing project or group keeps its settings. "Newcomer" is whichever side the suggestion was computed for. Read `suggest`'s shape and pick the side that does not already have a group. If neither side has a group, pick the more recently added one: an array index, or `createdAt` if the record has one.
   - Skip a pair that a link earlier in the same batch has made invalid (the host is now taken, or the project is now grouped). Catch the error and continue.
   - Save once at the end.
   - Return the pairs that were joined.
2. **Bridge** (`electron/bridge/handlers/projects.ts`): add `autoJoin` as a mutating method. `ElectronAPI` types come from the handler table automatically. Keep `suggestLinks` and `dismissLinkSuggestion`: ticket 2 uses the dismiss.
3. **Keep separate:** add `ProjectManager.keepSeparate(projectId)`. It runs `unlinkGroup` on the project's group and persists a dismissal (`OriginLinks.dismiss`) for every pair of former members, so `autoJoin` never re-joins them. Expose it on the bridge.
4. **Carry metadata on copy** (`host-transfer.ts`, copy branch): after the clone or adopt, copy `workspaceNames[source.path]` and `workspaceIssues[source.path]` to `[cloned.path]` on the new project's record, but only when the new record has no entry yet. An adopted project's own values win. Save.
5. **Project-id audit:** grep for state keyed by project id outside the project record (agent persistence, stats, notifications, layout). Report what doesn't follow a set up + remove. Don't fix any of it, just report.
6. **Tests:**
   - `origin-links.test.ts` or `project-groups.test.ts`, or a new `auto-join.test.ts`:
     - `autoJoin` joins a pair on two hosts.
     - It respects dismissals.
     - It never joins two groups.
     - It skips a pair that an earlier join invalidated.
     - The settings come from the existing project.
   - `keepSeparate` splits the group and stops a re-join.
   - `host-transfer.test.ts`: copy carries the name and issue, and an adopted project's own name wins.
   - Bridge validation tests for the new methods.

## Files to touch
- `electron/projects/project-manager.ts`
- `electron/projects/origin-links.ts` (if helpers are needed)
- `electron/projects/project-groups.ts` (if helpers are needed)
- `electron/projects/host-transfer.ts`
- `electron/bridge/handlers/projects.ts`
- tests next to each
