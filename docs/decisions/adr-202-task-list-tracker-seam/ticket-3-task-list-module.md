---
title: Deep taskList module (merge, linked rule, filter, search, sort, page)
status: done
priority: high
assignee: opus
blocked_by: [2]
---

# Deep taskList module

See ADR-202 §3 for the interface. New `src/lib/task-list.ts` (pure):

- `mergeSources(results)` — today's `combineResults` body from `useTasks.ts`
  (mark a row `assignedToMe` if any assigned query listed it, dedupe by
  `provider:url||key` keeping first, sort by updated) plus `failedCount`.
  `loading` stays in the hook.
- `entryLookup(projects)` — moved from `TasksView.tsx`.
- `taskList(input, prefs, trackers = TRACKERS)` returns `{ listed, matching,
  page(n, size?), top(n) }`:
  1. scope fetched rows to `prefs.provider` and `prefs.projectKey`;
  2. drop rows any workspace link matches (`trackers[row.provider].matchesLink`);
  3. add linked rows (today's `linkedTasks`, provider from
     `ownsLink`, fetched-row enrichment by `matchesLink`), scoped the same way;
  4. `listed` = unlinked ++ linked; `matching` = `applyTaskFilters` →
     search (today's `filterTasks`) → `sortTasksBy`;
  5. `page` = `paginate(matching, n, size)`; `top(n)` = `matching.slice(0, n)`.
  Memoise nothing here; the hooks memoise the call.
- Move `withoutLinkedTasks`, `linkedTasks`, `collectTasks`, `sortTasks`,
  `filterTasks` out of `tasks.ts` into `task-list.ts` as internals (not
  exported unless a test genuinely needs it). `LinkedTask`, `EntryOf` types
  can stay in `tasks.ts`.
- `src/lib/task-list.test.ts` using `memoryTracker`: the prefix property
  (`top(5)` equals `page(1).rows.slice(0,5)` and every `top` row is in
  `matching` in the same order) across a fixture with linked rows, a row only
  the assigned query listed, and one task listed through two entries;
  `mergeSources` (assigned marking, dedupe, failedCount); linked exclusion by
  URL (and a GitHub `#N` in another repo *not* excluded); provider/project
  scoping; search; filters see linked rows (`progress: in-progress`).
- Delete the corresponding blocks from `src/lib/tasks.test.ts`.

## Files to touch
- `src/lib/task-list.ts`, `src/lib/task-list.test.ts` — new
- `src/lib/tasks.ts`, `src/lib/tasks.test.ts` — remove moved code/tests
- `src/components/tasks/useTasks.ts` — use `mergeSources` (keep hook shape)
- `src/components/tasks/TasksView.tsx` — import `entryLookup` (temporary until ticket 4)
