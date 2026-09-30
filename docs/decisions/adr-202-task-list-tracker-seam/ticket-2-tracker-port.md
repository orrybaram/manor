---
title: TaskTracker port with GitHub, Linear and in-memory adapters
status: todo
priority: high
assignee: opus
blocked_by: [1]
---

# TaskTracker port with GitHub, Linear and in-memory adapters

See ADR-202 §2 for the interface. Create `src/lib/trackers/`:

- `types.ts` — `TrackerQuery<T>`, `TaskTracker`.
- `github.ts` — `githubTracker`. `toRow` = today's `fromGitHub` (moved from
  `tasks.ts`). `statusQuery` = `github.checkStatus()` → installed && authenticated,
  `staleTime: Infinity`, key `["trackers","github","status"]`. `listQuery(ctx, scope)`
  = `getMyIssues` / `getAllIssues(ghRepoOf(member), 50, "open")` mapped with
  `assignedToMe: scope === "assigned"`, key `["trackers","github","list",scope,hostId,path,entryKey]`.
  `detailQuery` keeps key `["github-issue-detail", hostId, path, number, url]`
  and returns `body`. `startWork` → `startGitHubIssueWork`. `ownsLink` = id
  starts with `gh-`. `matchesLink` = normalised URL equality (trailing `/`
  stripped, lowercased). `homeUrl` = today's GitHub branch of `trackerHomeUrl`.
- `linear.ts` — `linearTracker`, same shape: `isConnected()` (staleTime 60s,
  key `["trackers","linear","status"]`), `canList` = has `linearAssociations`,
  list with `stateTypes: ["unstarted","started","backlog"]`, limit 50, detail
  key `["linear-issue-detail", id]` returning `description`, `startLinearIssueWork`,
  `ownsLink` = !`gh-`, `matchesLink` = URL equality OR `link.id === raw.issue.id`.
- `memory.ts` — `memoryTracker(provider, rows)` for tests: list returns given
  rows, links match by URL, no electronAPI.
- `index.ts` — `TRACKERS`, `trackerFor`, `TRACKER_STATUS_KEY(provider)`.

`row.raw` is read only inside these adapters after ticket 4. No React imports
in `src/lib/trackers`. Remove `fromGitHub`, `fromLinear`, `trackerHomeUrl`
from `tasks.ts` and move their tests from `src/lib/tasks.test.ts` into
`src/lib/trackers/github.test.ts` / `linear.test.ts`, adding tests for
`ownsLink`, `matchesLink` (GitHub: `#12` in another repo does not match; URL
trailing slash / case does; Linear: id without URL matches) and `homeUrl`.

Callers (`useTasks`, `TasksView`) may temporarily import `toRow` /
`homeUrl` from the adapters so this ticket typechecks on its own; ticket 4
rewires them properly.

## Files to touch
- `src/lib/trackers/{types,github,linear,memory,index}.ts` — new
- `src/lib/trackers/{github,linear}.test.ts` — new
- `src/lib/tasks.ts` — remove the moved functions
- `src/lib/tasks.test.ts` — remove the moved tests
- `src/components/tasks/useTasks.ts`, `src/components/tasks/TasksView.tsx` — import updates only
