---
type: adr
status: accepted
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

# ADR-207: Consolidate the Tasks view and palette task UIs

Builds on ADR-198 (Tasks view), ADR-200 (palette search scope), ADR-201
(filter/sort), ADR-202 (tracker seam). Design comps:
https://claude.ai/artifact/C4JgdwPaPuRcxbN3D1YcAf

## Context

Tasks are browsable in two places that share no code:

- **Tasks view** (`src/components/tasks/`) — full page, every project, both
  trackers, fed by the tracker seam (`src/lib/trackers`) into one `TaskRow`
  model, with `task-prefs` filters and sort. Rows can only Start/Open; the ID
  and title open the browser (ADR-198 §3 stopgap — there is no detail view).
- **Palette** (`src/components/command-palette/`) — per-project, per-tracker
  "X Tasks" drill-ins (`linearItems` / `githubItems`, `CommandPalette.tsx:372`)
  into `LinearIssuesView` / `GitHubIssuesView`, which call
  `window.electronAPI.linear|github` directly, keep their own localStorage
  filters (`linear-issues-filter:*`, `github-issues-filter:*`) and use raw
  `<button>`/`<select>`. Selecting a row opens `IssueDetailView` /
  `GitHubIssueDetailView` — two ~330-line near-copies with their own
  keyboard handling, actions and CSS in `CommandPalette.module.css`.

The detail views are also embedded by `LinkedIssuesPopover` (status bar) in a
"linked" mode (Unlink / Close & Unlink), the only caller of that mode.

Problems found along the way:

- **Cache-key collision.** `linear.ts` `detailQuery` caches the description
  *string* under `["linear-issue-detail", id]`; `IssueDetailView` caches the
  full `LinearIssueDetail` *object* under the same key. Whichever fills first
  breaks the other. The GitHub keys differ only by accident (`issueUrl`).
- `IssueDetailView`'s Create Workspace picks the first project with any
  Linear association, not the issue's project.
- Dead plumbing: `initialIssueId` / `initialGitHubIssueNumber` are only ever
  set to null; `TasksView`'s `onOpenPaletteView` is never used;
  `useIssuesShortcut` already calls `showTasksView()` and uses
  `onOpenPaletteView` only as a truthiness gate.
- `IssueDetailSkeleton`'s hint says Enter creates a workspace; Enter is New
  Agent.

## Decision

One data model (the tracker seam), one detail component, two surfaces with
distinct jobs: **the palette finds and acts; the Tasks view browses and
triages.**

### 1. Seam: a normalized task detail

In `src/lib/trackers/types.ts` / `src/lib/tasks.ts`:

- `TaskRef = { provider; project: ProjectInfo; id; displayId; title; url }` —
  enough to fetch and act on a task whether it came from a `TaskRow` or a
  workspace's `LinkedIssue`. Each adapter exports `refOf(row)` and
  `refFromLink(link, project)` (GitHub: `id` `"gh-N"` → number).
- `TaskDetail = { body: string | null; status; assignees: string[];
  labels: TaskLabel[]; priority?; milestone?; images: string[] }`.
- `detailQuery(ref): TrackerQuery<TaskDetail>` replaces the body-only query,
  under a new key `["task-detail", provider, …]` used by nothing else — fixes
  the collision. `useStartTask` reads `.body`.
- Optional adapter methods, moved out of the detail views and popover:
  `unlink(ref, projectId, workspacePath)`, `close(ref)`. Errors surface as
  toasts in one place. (A `startHere` for "New agent here" was built, then
  removed — see Amendments.)

### 2. `TaskDetail` component

`src/components/tasks/TaskDetail/` — tracker-agnostic, takes a `TaskRef`
(+ optional `TaskRow` for Start), renders title, status pill, assignees,
project, labels, priority/milestone, markdown body + proxied images, and an
action bar. Modes:

- `default` — Start in new workspace (↵), Open in tracker (⌘O).
- `linked` — Linked to *X*, Unlink, Close & Unlink, Open in tracker.

Layout variants: `card` (palette wide card, popover dialog) and `drawer`.
Uses `ui/` components only. Owns its loading skeleton and error/Retry state.

### 3. Tasks view drawer

Clicking a row title opens `TaskDetail` (`drawer`) in a 440px right panel;
the ID chip still opens the tracker. While open the table drops the
Assignees and Priority columns, the selected row is highlighted, ↑/↓ (and
j/k) move the selection, Esc closes. Linked rows resolve their `TaskRef` via
`refFromLink` and the project from `projectId`, and open in `linked` mode.
Option B (full-page detail) from the comps is rejected — it loses the list.

### 4. Palette: tasks inline in search

- Delete the "X Tasks" drill-ins, `LinearIssuesView`, `GitHubIssuesView`,
  `IssueListSkeleton` and their localStorage filters. The Linear "My Tasks"
  toggle goes with them; the Tasks view's assignee filter covers it.
- When the query is non-empty, a **Tasks** category lists the top 5 matches
  from `useTasks` + `taskList` (respecting the ADR-200 scope chip; `useTasks`
  gains `enabled` so nothing is fetched until the user types, and shares the
  Tasks view's query cache). Rows: tracker icon, ID, title, project or linked
  workspace, status. **Enter** = Start (or Open a linked task); **→** = detail.
- A trailing row "See all N matching tasks in Tasks view" calls
  `showTasksView({ search, project })`.
- Detail is one palette view, `task-detail`, holding a `TaskRef`, rendering
  `TaskDetail` (`card`). Root ⌘↵ keeps its ADR-200 meaning (widen scope).
- `PaletteView` loses `linear-all`, `github-all`, `issue-detail`,
  `github-issue-detail`; `initialIssueId` / `initialGitHubIssueNumber` go.

### 5. `showTasksView` intent

`showTasksView(intent?: { search?: string; project?: string | null })` stores
a one-shot `tasksIntent` in app-store; `TasksView` consumes it on mount and
when it changes (sets its search, calls `prefs.setProject`), then clears it.
`useIssuesShortcut` passes the selected project's entry key and drops its
`onOpenPaletteView` parameter.

### 6. LinkedIssuesPopover

Its dialog embeds `TaskDetail` (`linked`, `card`) instead of the two detail
views; its context-menu Unlink/Close call the seam's `unlink` / `close`.

## Consequences

- ~1,300 lines deleted (two list views, two detail views, two skeletons,
  their CSS), one filter system, one detail implementation, one place for
  unlink/close error handling.
- Adding a tracker means one seam adapter; the palette needs no changes.
- Tasks view rows finally have a detail view, closing the ADR-198 §3
  stopgap.
- The palette loses its per-tracker browse lists and their status/priority
  filters. Browsing moves to the Tasks view — one keystroke away via
  "See all" or Go to → Tasks.
- Typing in the palette now triggers tracker fetches (cached, stale-while-
  revalidate). Gated on a non-empty query to keep palette open instant.
- `refFromLink` for GitHub depends on the `"gh-N"` id convention already used
  by linking.
- Orphaned localStorage keys (`*-issues-filter:*`) are left; harmless.
- Risk: palette keyboard handling — → on a task row must not break cmdk
  input caret movement; only intercept → when the input caret is at the end.

## Amendments

After review (2026-10-01):

- **"New agent here" removed.** It was too easy to confuse with Start; Start
  (new workspace) is the one way to begin a task. Gone with it: the seam's
  `startHere`, the ⌘↵ shortcut in the detail, and the `onNewAgentWithPrompt`
  plumbing through the palette, Tasks view and status bar. "Link to
  workspace" was never built.
- **"See all" clears filters.** It opens the top match's tracker with that
  tracker's filters cleared, and counts only that tracker's matches, so both
  views list the same tasks.
- **Drawer:** the open-in-tracker link lives in the drawer header only.
- **Palette** widened to 700px with the comps' row styling.
- **Palette keys:** on a task row ↵ or → opens the detail; ⌘↵ starts it (or
  opens a linked task's workspace) — also inside the detail. Root ⌘↵ still
  widens the scope when no task row is highlighted; with one highlighted,
  Tab does.
- **Scope chip** is a picker of sidebar entries (All projects + each
  project), tinted with the entry's colour. Linked checkouts (a group's local
  and remote members) are one entry, and scoping to it covers every member's
  workspaces, agents and tasks.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
