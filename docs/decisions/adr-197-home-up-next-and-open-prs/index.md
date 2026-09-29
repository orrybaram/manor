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

# ADR-197: Home: Up next per project, a dedicated Up next view, and an Open PRs widget

## Context

Home (ADR-194) has three things that don't line up:

1. **Up next shows the top 3 issues overall.** `useUpNextIssues` ranks every
   unlinked, assigned issue across all projects and both sources (GitHub
   `--assignee @me`, and Linear unstarted/backlog issues), then shows the first 3
   (`TOP_COUNT = 3`). `rankUpNext` sorts `ready-for-agent` first, then by sidebar
   order, so a few busy projects can fill all three slots and the other projects
   never appear.
2. **"All issues" doesn't match "N issues ready".** The summary line counts the
   full cross-project, cross-source Up next list (`upNext.total`). The section's
   "All issues" link opens the command palette's `linear-all` or `github-all`
   view for the *selected* project only (`HomeDashboard.tsx:185-187`). That
   shows one source and one project, and it includes issues that are already
   linked. So clicking through never shows the 13 issues the count refers to.
3. **Open PRs appear only as a count.** "4 open PRs" is `openPrCount(projects)`.
   Needs you lists only the PRs that are `blocked` or `ready`. PRs that are in
   review, queued or pending have no place on Home, and none of them show
   check/review status there.

## Decision

### 1. Up next: top 3 per project

- `useUpNextIssues` returns three things:
  - `all`: every ranked row, as now.
  - `top`: the rows grouped by top-level entry in sidebar order, with each
    entry capped at `PER_PROJECT = 3`. Each project keeps its `rankUpNext`
    order, so `ready-for-agent` issues come first.
  - `total` and `loading`, unchanged.
- The grouping is a new pure selector, `topUpNextPerProject(rows, projectOrder,
  n)`, in `src/lib/home-dashboard.ts`, with unit tests.
- The dashboard renders `top`. Each row already carries its project chip, so the
  grouping shows up as runs of the same chip.

### 2. A dedicated Up next palette view

- Add `"up-next"` to `PaletteView` (`src/components/command-palette/types.ts`).
- Add `UpNextView.tsx` in `src/components/command-palette/`. It lists
  `useUpNextIssues().all` as cmdk items, grouped under one `Command.Group` per
  project (the heading is the project name), and uses the palette's existing
  search input.
  - Each item shows a source icon (the existing `GitHubIcon` / `LinearIcon`),
    the identifier, the title, and `ready-for-agent` as a hint where it applies.
  - Selecting an item starts work the same way the dashboard row does.
- The dashboard's issue-to-workspace logic (`handleUpNextClick`: fetch the
  issue body, then `startGitHubIssueWork` / `startLinearIssueWork`) moves into a
  shared hook, `useStartUpNextIssue(onNewWorkspace)`, in
  `src/components/sidebar/HomeDashboard/useStartUpNextIssue.ts`. Both the
  dashboard and `UpNextView` use it.
- `CommandPalette.tsx` treats `up-next` as an issue-list view, with the header
  "Up next" and the placeholder "Search issues...".
- On Home, "All issues" is replaced by "View all (N)", which opens `up-next`.
  The per-project, single-source GitHub/Linear views are still reachable from
  the palette and the issues shortcut; only Home's link changes.

### 3. Open PRs widget

- Add a new pure selector, `openPrRows(projects)`, in `home-dashboard.ts`.
  - It returns `{ pr, project, workspace, readiness, label }` for every open PR
    linked to a workspace, deduped by URL like `openPrCount`.
  - Rows are ordered by readiness (`blocked`, `ready`, `review`, `queued`,
    `pending`), then by project and workspace order.
  - `label` reuses `blockedReason` for blocked PRs. The other labels are "ready
    to merge", "needs review", "queued to merge", "draft", "checks running" and
    "pending".
- Add an "Open PRs" section on Home, below Up next.
  - Each row has the existing `PrPopover` badge, so it gets the same readiness
    colour and icon as the sidebar, plus the hover popover with checks and
    comments.
  - Then the PR title, the status label, and the project chip plus workspace
    name.
  - Clicking a row selects its workspace, as Needs you PR rows do. Clicking the
    badge opens the PR on GitHub, as it does in the sidebar.
- The section shows up to 5 rows, with a "N more" expander like Needs you.
- PRs also listed in Needs you (`blocked` / `ready`) still appear here. Needs
  you is a to-do list; this section is an inventory.

## Consequences

- Up next shows up to 3 × (number of projects) rows. With many projects, Home
  gets longer. That is the accepted cost of giving every project a slot.
- The per-source query limit (10 issues) still caps `total` at 10 per source for
  each project. That limit is left as it is.
- Home's issue link now always matches its count, at the cost of one more
  palette view. `UpNextView` reuses the dashboard hook, so both use the same
  polling query cache and no extra `gh` calls are made.
- The Open PRs widget adds no new fetching; it reads the `ws.pr` data the
  sidebar already polls. A PR that isn't linked to a workspace doesn't show,
  which matches what the count means.
- Blocked and ready PRs show on Home twice, once in Needs you and once in Open
  PRs. The two sections answer different questions, so this is deliberate.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
