---
title: TasksView page with table, filters and pagination
status: done
priority: high
assignee: opus
blocked_by: [1, 2]
---

# TasksView page with table, filters and pagination

ADR-198 §3. Replace the placeholder `src/components/tasks/TasksView.tsx`.
Read `.claude/rules/ui-components.md` and `src/components/ui/` first — use
`Button`, `Link`, `Tooltip`, `ToggleGroup`, `SearchableSelect`, `CountBadge`,
`Input` rather than raw elements.

- `src/lib/tasks.ts` (pure) + `src/lib/tasks.test.ts`: `TaskRow`
  `{ key, provider: "github"|"linear", displayId, title, url, labels:{name,color?}[],
  assignees:string[], status:{label, tone}, updatedAt, projectEntryKey, project,
  projectName, color, raw }`; `fromGitHub`, `fromLinear`, `filterTasks(rows, query)`
  (title/id/label substring, case-insensitive), sort by `updatedAt` desc,
  `paginate(rows, page, size=25)`, `relativeTime(iso, now)`.
- `src/components/tasks/useTasks.ts`: generalise the fan-out in
  `src/components/sidebar/HomeDashboard/useUpNextIssues.ts` — one `useQueries`
  entry per top-level entry's primary member per provider; filter "assigned"
  → `getMyIssues`, "open" → `getAllIssues` (GitHub state "open"; Linear
  stateTypes unstarted/started/backlog), limit 50; 60s staleTime, retry false,
  failures swallowed and counted; expose `{rows, loading, failedCount, refetch}`.
  Consider extracting the shared "sources" computation instead of duplicating.
- `TasksView.tsx` + `TasksView.module.css`: layout per ADR §3 — full width with
  24px padding; provider tabs (icon buttons), project select ("All projects"
  + entries with color dot), open-in-browser `Link` when a single project is
  selected; filter row: Open / Assigned to me, search input with search icon,
  refresh button; table (CSS grid, not `<table>` required) with header
  labels uppercase letter-spaced dim (ID, TITLE / CONTEXT, ASSIGNEES, STATUS,
  UPDATED); rows 64px, hover background, ID chip, bold title with project name
  + label chips below, initial avatars, status pill (green for open/started,
  dim for backlog, purple for closed), relative updated, "Start →" button that
  calls `startGitHubIssueWork` / `startLinearIssueWork` from
  `src/lib/start-issue-work.ts` with the row's project and
  `onNewWorkspace`; row click opens the palette detail
  (`onOpenPaletteView` with the right view + id — check CommandPalette's
  initial-view props; if selecting a specific issue isn't supported, open the
  URL instead and note it). Pagination footer. Loading skeleton, empty
  state, and "N sources failed" note. Persist provider/filter/project in
  localStorage (try/catch), like GitHubIssuesView does.
- Use theme tokens from `src/App.css` (`--surface`, `--text-dim`,
  `--text-selected`, `--accent`, borders) — no hardcoded colors except label
  colors from the tracker.

## Files to touch
- `src/lib/tasks.ts`, `src/lib/tasks.test.ts`
- `src/components/tasks/useTasks.ts`
- `src/components/tasks/TasksView.tsx`, `TasksView.module.css`
- optionally `src/components/sidebar/HomeDashboard/useUpNextIssues.ts` (shared sources helper)
