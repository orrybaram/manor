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

# ADR-202: One Task list module behind a two-adapter tracker seam

Builds on ADR-198 (Tasks view) and ADR-201 (filter and sort). Keeps the
ADR-201 field model (`TASK_FIELDS`, `applyTaskFilters`, `sortTasksBy`,
`facetOptions`) unchanged.

## Context

Home's Up next is meant to be "the top of the Tasks list" (9c3e441c,
a27c4ffc). It isn't built that way:

- **The list pipeline is assembled twice.** `TasksView.tsx` (≈171–205) chains
  `withoutLinkedTasks` → `linkedTasks` → `applyTaskFilters` → `filterTasks` →
  `sortTasksBy` → `paginate` in six `useMemo`s. `UpNextPanel.tsx` (≈56–66)
  rebuilds a different subset: it drops linked tasks entirely (Tasks lists them
  as in-progress rows), merges both trackers, reads prefs straight from
  localStorage and compares filters to the defaults with `JSON.stringify`.
  With default filters (`progress: not-started`) the two agree by accident;
  once a user clears filters, Up next silently stops being a prefix of Tasks.
- **No tracker seam.** The provider is a `"github" | "linear"` string that
  callers branch on: `useTasks` (query building, ≈194), `useStartTask` (detail
  fetch + start, ≈29), `fromGitHub`/`fromLinear`, `withoutLinkedTasks`
  (Linear-only id rule), `linkedTasks` (guesses the provider from a `gh-` id
  prefix), `trackerHomeUrl`, `TaskTableRow` (icon), `TasksView` (icon, labels).
  Each new tracker behaviour means touching all of them.
- **`combineResults`** (merge of the open + assigned-to-me queries, mark
  `assignedToMe`, dedupe) is private to `useTasks` and untested.
- **Dead code.** `command-palette/UpNextView.tsx`,
  `HomeDashboard/useUpNextIssues.ts`, `HomeDashboard/useStartUpNextIssue.ts`
  (a near copy of `useStartTask`), and in `src/lib/home-dashboard.ts`:
  `normalizeIssueRef`, `isIssueLinked`, `UpNextIssue`, `rankUpNext`,
  `upNextFromGitHub`/`upNextFromLinear`, `upNextList`, `topUpNextPerProject`,
  `openPrRows`, `openPrLabel` (+ `OpenPrRow`, `OpenPrReadiness`,
  `OPEN_PR_RANK`), with their tests in `home-dashboard.test.ts`. Nothing
  imports them (verified by grep; `home-dashboard-studio.ts` only names
  `openPrRows` in a comment). `isIssueLinked` treats `gh-12` / `12` / `#12` as
  one issue across repos — a second "is this linked?" rule that contradicts
  `withoutLinkedTasks` (URL match). The tracker status queries still use
  `["home-up-next", …]` keys (in `useTasks`, `TasksView`, `Sidebar`).

## Decision

### 1. Delete the dead chain first (own commit)

Remove the files and functions listed above and their tests. Keep
`primaryMember` (used by `useTasks`) and everything the PR-verdict workspace
owns (`blockedReason`, `prReadiness`, PR stage code). Rename the status query
keys to `["trackers", "github", "status"]` / `["trackers", "linear",
"status"]`, exported once as `TRACKER_STATUS_KEY` from the tracker module so
`Sidebar.tsx`, `useTasks` and `TasksView` (GitHub-installed invalidation)
share it. The list queries move from `["tasks", …]` to `["trackers", provider,
"list", …]`.

### 2. `TaskTracker` port with GitHub and Linear adapters

New folder `src/lib/trackers/`:

```ts
// src/lib/trackers/types.ts
export interface TrackerQuery<T> { queryKey: readonly unknown[]; queryFn: () => Promise<T>; staleTime: number }

export interface TaskTracker {
  provider: TaskProvider;               // "github" | "linear"
  label: string;                        // "GitHub" / "Linear"
  /** Is it usable at all (gh installed + authed / Linear connected). */
  statusQuery(): TrackerQuery<boolean>;
  /** Can `member` be queried through this tracker (Linear: has a team association). */
  canList(member: ProjectInfo): boolean;
  /** The open, or assigned-to-me, rows of one source, already mapped to TaskRow. */
  listQuery(ctx: TaskContext, scope: "open" | "assigned"): TrackerQuery<TaskRow[]>;
  /** The row's body/description, for the agent prompt (null when unavailable). */
  detailQuery(row: TaskRow): TrackerQuery<string | null>;
  /** Open the New Workspace dialog prefilled, or reuse a workspace on the branch. */
  startWork(row: TaskRow, body: string | null, onNewWorkspace?: NewWorkspaceHandler): void;
  /** Does this tracker own a workspace link (`gh-N` ids are GitHub's). */
  ownsLink(link: LinkedIssue): boolean;
  /** Is `row` the task `link` points at. GitHub: URL. Linear: URL or issue id. */
  matchesLink(link: LinkedIssue, row: TaskRow): boolean;
  /** Tracker page for one project's rows (repo issues / Linear team). */
  homeUrl(rows: readonly TaskRow[]): string | null;
}
```

- `github.ts` and `linear.ts` are the only places (besides `electron.d.ts`)
  that read `window.electronAPI.github|linear` for the task list, and the only
  readers of `row.raw`. `fromGitHub`/`fromLinear` move into them (renamed
  `toRow`, still exported for tests). They reuse `start-issue-work.ts`
  (`startGitHubIssueWork` / `startLinearIssueWork`) unchanged. `detailQuery`
  keeps the palette's cache keys (`github-issue-detail…`, `linear-issue-detail…`).
- `index.ts` exports `TRACKERS: Record<TaskProvider, TaskTracker>` and
  `trackerFor(provider)`. React stays out of `src/lib/trackers`; hooks run the
  query descriptors.
- `memory.ts` — an in-memory adapter (rows + links given up front) used by the
  task-list tests.
- UI-only per-provider bits (icons) become a small `TRACKER_ICON` map in
  `src/components/tasks/` rather than `provider === "github"` ternaries.

### 3. One deep Task list module

New `src/lib/task-list.ts` (pure, no React / store):

```ts
export interface TaskListPrefs {
  provider: TaskProvider;
  projectKey: string | null;            // null = all projects
  filters: TaskFilters;
  sort: TaskSort;
  search?: string;
}

/** Merge the per-source query results: mark rows the assigned query listed, dedupe. */
export function mergeSources(results: readonly SourceResult[]): { rows: TaskRow[]; failedCount: number };

export interface TaskList {
  listed: (TaskRow | LinkedTask)[];     // before filters — facet counts come from here
  matching: (TaskRow | LinkedTask)[];   // filtered + searched + sorted
  page(n: number, size?: number): TaskPage<TaskRow | LinkedTask>;
  top(n: number): (TaskRow | LinkedTask)[];
}

export function taskList(
  input: { rows: readonly TaskRow[]; projects: readonly ProjectInfo[]; entryOf: EntryOf },
  prefs: TaskListPrefs,
  trackers?: Record<TaskProvider, TaskTracker>,   // defaults to TRACKERS; tests pass memory
): TaskList;
```

It owns: excluding fetched rows that a workspace link matches (via
`tracker.matchesLink`), adding the linked rows (`linkedTasks`, provider via
`tracker.ownsLink` instead of the `gh-` guess), scoping to provider/project,
filters, search, sort, and paging. `mergeSources` is `combineResults` moved
out of `useTasks` and made testable. `entryLookup` moves from `TasksView` into
the module (as `entryLookup(projects)`) so both views derive entries the same
way.

`tasks.ts` keeps the row types, the ADR-201 field model, `paginate`,
`pageWindow`, `relativeTime`, `initialOf`. `withoutLinkedTasks`,
`linkedTasks`, `collectTasks`, `filterTasks`, `sortTasks`, `trackerHomeUrl`,
`fromGitHub`/`fromLinear` become module-internal or move to the adapters;
their tests move to the new interfaces ("replace, don't layer").

### 4. Both views call it

- `useTaskPrefs()` (in `task-prefs.ts`) returns the saved provider, project,
  per-provider sort and filters — the one reader of localStorage, used by both
  views. `isDefaultFilters(filters)` replaces the `JSON.stringify` compares.
- `useTasks({ provider, projectKey })` iterates `TRACKERS[provider]` query
  descriptors and folds them with `mergeSources`; no provider branching.
- `useStartTask` becomes `fetch tracker.detailQuery(row)` →
  `tracker.startWork(row, body, onNewWorkspace)`.
- `TasksView` replaces its six `useMemo`s with one `taskList(...)` call.
- **`UpNextPanel` = `taskList(sameInput, savedPrefs).top(5)`** — the saved
  provider, project, filters and sort, i.e. exactly the list "View all" opens,
  including in-progress linked rows (action "Open") when the filters let them
  through. The count in "View all N" is `matching.length`. Up next no longer
  merges the other tracker (see Consequences).

### 5. Tests

- `task-list.test.ts` (against the in-memory adapter): Up next (`top(n)`) is a
  prefix of Tasks (`page(1)`) for the same prefs — with linked rows, rows only
  the assigned query listed, and duplicates across two entries; merge marks
  assigned + dedupes + counts failures; linked-row exclusion; provider/project
  scoping; search.
- `trackers/github.test.ts`, `trackers/linear.test.ts`: `toRow` mapping (moved
  from `tasks.test.ts`), `ownsLink`, `matchesLink` (GitHub: same number in
  another repo does **not** match; trailing slash / case-insensitive URL does;
  Linear: id match without URL), `homeUrl`.
- Remove the now-redundant `withoutLinkedTasks` / `linkedTasks` /
  `collectTasks` / `fromGitHub` / `fromLinear` / `trackerHomeUrl` blocks from
  `tasks.test.ts`; keep the field-model tests.

## Consequences

- **Better:** one list rule and one linked rule; "Up next ⊆ Tasks" is a test,
  not a hope. Provider differences sit in two adapter files; adding a tracker
  (or a field) touches the adapter, not five callers. `mergeSources` and link
  matching are tested without React. ≈330 dead lines go.
- **Behaviour change:** Up next shows the last-viewed tracker (and last
  project) only, matching what "View all" opens. Someone using both GitHub and
  Linear sees one tracker's top five on Home — the tracker they last chose in
  Tasks. The panel subtitle names the tracker (and project, when scoped).
  With cleared filters, Up next can now show in-progress linked tasks (they
  get "Open", as in Tasks).
- **Cache keys change** (`home-up-next` → `trackers`): one extra fetch on first
  load after update; no persisted cache depends on them.
- **Risk / conflicts:** touches `Sidebar.tsx` (two query-key lines) and a
  comment in `home-dashboard-studio.ts`, outside this workspace's main area;
  kept to the minimum. `home-dashboard.ts` deletions stay clear of
  `blockedReason` / `prReadiness` (PR-verdict workspace). `project-store.ts`
  is not touched.
- **Harder:** the port is a new indirection; `row.raw` is now read only by
  adapters, so a caller that needs raw tracker data must go through one.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
