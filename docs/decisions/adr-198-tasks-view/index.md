---
type: adr
status: proposed
database:
  schema:
    status:
      type: select
      options: [todo, in-progress, review, done]
      default: todo
    priority:
      type: select
      options: [critical, high, medium, low]
    assignee:
      type: select
      options: [opus, sonnet, haiku]
  defaultView: board
  groupBy: status
---

# ADR-198: Tasks view

Builds on ADR-194 (Projects overview / `activeSurface`), ADR-195/196 (sidebar,
window frame). Inspiration: Orca's "Tasks" screen (provider tabs, filter chips,
query bar, table with ID / Title / Assignees / Status / Updated / Start,
pagination).

## Context

Issues are only browsable inside the command palette (`GitHubIssuesView`,
`LinearIssuesView`), one project at a time, in a narrow list. Home's "Up next"
(`useUpNextIssues`) already fans `getMyIssues` out across every top-level
project, but shows only three. There is no full-page place to see "everything
on my plate" across projects and start work on it.

The user also wants the concept renamed: **"Issues" → "Tasks"** everywhere in
the UI.

Data today (`electron/github.ts:354`, `electron/linear.ts:115,180`): list
calls return id/number, title, url, state, labels, assignees (GitHub) — no
`updatedAt`, no author, and Linear list results carry no assignee. GitLab is
not supported anywhere, so it is out of scope (no GitLab tab).

## Decision

### 1. A third app surface: `"tasks"`

- `AppSurface = "workspace" | "projects" | "tasks"` in `src/store/app-store.ts`;
  new `showTasksView()` mirroring `showProjectsOverview()` (leaves the active
  workspace alone).
- Navigation history: `selectCurrentLocation` maps it to
  `{kind:"surface", surface:"tasks"}`; `applyLocation` replays via
  `showTasksView()`; extend the Location union.
- `App.tsx` renders `<TasksView>` in the `empty-surface` slot when the surface
  is `"tasks"` (same slot and hide-workspace rule as the Projects overview).

### 2. Sidebar row

A **Tasks** row between Home and Projects in `Sidebar.tsx`, styled like the
Home row (`ListTodo` icon, active state, roving-row keyboard support). On the
right, small dimmed icons of the connected trackers (GitHub when `gh` is
available, Linear when connected), as in the inspo.

### 3. `TasksView` (`src/components/tasks/`)

Full-width page (not the 760px column) inside a bordered panel:

- **Header row:** provider tabs (GitHub / Linear icon buttons, only for
  connected providers), a project `SearchableSelect` ("All projects" default,
  then each top-level entry with its color dot), and an "open in browser"
  `Link` to the repo's issues page / Linear team when one project is picked.
- **Filter row:** `ToggleGroup` with **Open** / **Assigned to me** (default
  Assigned to me), a search input filtering title/ID/labels client-side, and a
  refresh `Button` (refetches queries). No Issues/PRs toggle — PRs are out of
  scope for this ADR.
- **Table:** columns ID (`#123` / `ENG-45` chip; click opens the URL),
  Title + context (project name, labels as colored chips), Assignees (initial
  avatars), Status (pill: GitHub open/closed; Linear state name tinted by
  state type), Updated (relative time), and a **Start →** button calling the
  existing `startGitHubIssueWork` / `startLinearIssueWork`
  (`src/lib/start-issue-work.ts`) with the row's project. Clicking a row
  opens the existing palette detail view for that task.
- **Pagination:** client-side, 25 rows/page, Previous / page numbers / Next.
- **States:** skeleton rows while loading; per-source failures are swallowed
  and surfaced as a dim "N sources failed" note; empty state with provider
  setup hints (reuse GitHubNudge copy) when nothing is connected.
- Data: new `useTasks({provider, projectKey, filter})` hook generalising
  `useUpNextIssues`' fan-out (`useQueries` per top-level entry's primary
  member), normalised into a `TaskRow` type in `src/lib/tasks.ts` (pure,
  unit-tested: normalise, filter, sort by updated desc, paginate).

### 4. Richer list data

- GitHub `gh issue list --json` adds `updatedAt,author`; `GitHubIssue` gains
  `updatedAt: string`, `author: {login}`.
- Linear list query adds `updatedAt` and `assignee { name displayName }`;
  `LinearIssue` gains `updatedAt: string`, `assignee?: {name}`.
- Update `src/electron.d.ts` types and any fixtures/tests.

### 5. Rename "Issues" → "Tasks" in UI copy

All user-facing strings (palette items "Issues" → "Tasks", "GitHub — Issues",
"Search issues…", "My Issues" → "My Tasks", "No issues found", toasts,
"Linked Issues", status bar "`n` issues", Home "All issues"/"issue(s)
ready", "Your Issues" launcher + app menu item, GitHubNudge, settings copy
and settings-search keywords (keep "issues" as an extra keyword so search
still finds it)). The **"Your Tasks"** menu item/launcher now opens the Tasks
view instead of the palette.

Not renamed: code identifiers, IPC channels, MCP tool descriptions
(agent-facing), and "Report an Issue on GitHub" / FeedbackModal copy (those
are GitHub issues about Manor itself).

## Consequences

- One place to see and start all assigned work across projects; the palette
  views remain for quick keyboard access.
- The page fires one query per project × provider; reuses react-query caching
  and a 60s stale time like Up next. Many projects → many `gh` calls on open.
- "Tasks" in the UI vs "issue" in code is a deliberate vocabulary split.
- No GitLab, no PRs tab, no server-side search/pagination — follow-ups.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
