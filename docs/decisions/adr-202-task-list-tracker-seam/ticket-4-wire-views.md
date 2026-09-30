---
title: Wire TasksView and UpNextPanel onto taskList and the tracker port
status: todo
priority: high
assignee: opus
blocked_by: [3]
---

# Wire TasksView and UpNextPanel onto taskList and the tracker port

See ADR-202 §4.

- `task-prefs.ts`: add `useTaskPrefs()` returning `{ provider, projectKey,
  sorts, filtersBy }` read once from localStorage plus setters that also write
  (TasksView's current `useState` + `writePref` logic moves here), and
  `isDefaultFilters(filters)` (order-insensitive compare to
  `DEFAULT_TASK_FILTERS`, no `JSON.stringify`).
- `useTasks.ts`: `useTrackerSources` runs `TRACKERS[p].statusQuery()` for each
  provider and builds sources with `tracker.canList(member)`; `useTasks` maps
  sources × `["assigned","open"]` to `tracker.listQuery(ctx, scope)` wrapped in
  `settle`, combined by `mergeSources`. No `provider === …` branches.
- `useStartTask.ts`: `queryClient.fetchQuery(tracker.detailQuery(row)).catch(() => null)`
  then `tracker.startWork(row, body, onNewWorkspace)`.
- `TasksView.tsx`: replace `unlinked`/`linked`/`listed`/`narrowed`/`searched`/
  `sorted`/`current` memos with one memoised `taskList(...)`; facet counts from
  `list.listed`; header counts from `listed`/`matching`; `homeUrl` via
  `trackerFor(provider).homeUrl(rows)`; labels via `tracker.label`; GitHub
  install invalidates `TRACKER_STATUS_KEY("github")`. Keep the UI identical.
- `TaskTableRow.tsx` / `TasksView.tsx`: provider icon from a `TRACKER_ICON`
  map (new `src/components/tasks/tracker-icons.tsx`) instead of ternaries.
- `UpNextPanel.tsx`: `useTaskPrefs()` + one `useTasks({ provider, projectKey })`
  (the saved ones, falling back like TasksView does when the saved tracker is
  unusable) + `taskList(...).top(5)`. Linked rows get "Open" (reuse
  TasksView's `openLinked`, moved to a shared helper in `src/components/tasks/`).
  Subtitle: "Assigned to you, not started" when `isDefaultFilters`, else
  "Matching your Tasks filters"; append " · <Tracker>" (and project name when
  scoped). "View all N" uses `matching.length`.
- Run `pnpm typecheck` (or the repo's equivalent) and the tasks/task-list/
  trackers/home-dashboard tests.

## Files to touch
- `src/components/tasks/task-prefs.ts`, `useTasks.ts`, `useStartTask.ts`, `TasksView.tsx`, `TaskTableRow.tsx`
- `src/components/tasks/tracker-icons.tsx`, `src/components/tasks/open-linked-task.ts` — new
- `src/components/sidebar/HomeDashboard/UpNextPanel.tsx`
- `src/components/sidebar/Sidebar/Sidebar.tsx` — use `TRACKER_STATUS_KEY` / `statusQuery` (tiny)
