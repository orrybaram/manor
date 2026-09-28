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

# ADR-194: Home dashboard and Projects overview

Builds on ADR-153 (Home / orchestrator), ADR-167 (sidebar indicator states),
ADR-192/193 (linked projects). Research: `docs/research/home-dashboard.md`.
Prototype: https://claude.ai/artifact/EaD3UoCDBmob6ia4nkEwpa

## Context

Home (`HOME_PATH = "__home__"`, `src/lib/home-path.ts`) shows
`HomeEmptyState` when it has no tabs: the Manor logo and six launcher rows
(Add Project, New Agent, Open Terminal, New Browser Window, Command Palette,
Your Issues). It says nothing about the state of the user's projects, even
though the renderer already holds most of what's needed across all projects:

- per-pane agent status (`useAppStore.paneAgentStatus`) and agent records
  (`useAgentStore.agents`, unseen sets);
- per-workspace PR state (`WorkspaceInfo.pr`, ranked by `prReadiness()` in
  `src/lib/pr-readiness.ts`);
- linked issues per workspace (`WorkspaceInfo.linkedIssues`), and IPC for "my
  issues" (`github.getMyIssues`, `linear.getMyIssues`).

The user wants Home to answer "what needs me, and what's next" across every
project, **deterministically** (no LLM calls) for this first iteration.

Separately, there's no place that shows all projects at once, and the
zero-project onboarding (`WelcomeEmptyState`) is a single "Open Project"
drop zone that shares nothing with the rest of the app. The sidebar's
**Projects** heading is a dead label (right-click → Add Project only).

## Decision

### 1. Home: trimmed launchers plus three sections

`HomeEmptyState` keeps the `EmptyStateShell` look (logo, 480px column, rows
with keycaps) and changes as follows:

- **Launchers:** New Agent ⌘N, Open Terminal ⌘T, Command Palette ⌘K. Add
  Project, New Browser Window and Your Issues are removed from Home (⌘⇧B still
  works; Add Project moves to the Projects overview). Home is only reachable
  with ≥1 project, because the sidebar is hidden with zero projects and §3
  sends that case to the Projects overview.
- **Needs you** (hidden when empty): up to 4 rows, then an "N more" row that
  expands in place. Tiers, in order:
  1. agent pane `requires_input`
  2. agent pane `error`
  3. PR `prReadiness(pr) === "blocked"` (label from the cause: checks failing /
     conflicts / changes requested / N unresolved threads)
  4. PR `prReadiness(pr) === "ready"` ("ready to merge")
  5. agent `responded` and in `unseenRespondedAgentIds` ("finished")

  Within an agent tier, the oldest `AgentInfo.updatedAt` comes first. Within a
  PR tier, rows follow sidebar project order, then workspace order. Only
  project agents count (Home agents live in Home's own tabs, which hide this
  view). PRs are deduped by `pr.url`. Clicking an agent row calls
  `navigateToAgent`. Clicking a PR row opens its workspace
  (`selectProject` + `selectWorkspace`). The dashboard does not merge; that
  stays in the sidebar/PR popover.
- **Up next** (hidden when empty): up to 3 open issues assigned to the user,
  across projects, with no linked workspace. GitHub via
  `github.getMyIssues(ghRepoOf(project), 10)`, Linear via
  `linear.getMyIssues(teamIds, { stateTypes: ["unstarted", "backlog"] })`, one
  query per top-level entry (a linked group queries once through its
  `lastUsedHostId` member). React Query with `staleTime: 60_000`, and a failed
  source is silently skipped. An issue is "linked" if any workspace's
  `linkedIssues` matches by URL, or by normalized number (`gh-12` ≡ `12` ≡
  `#12`). Order: issues labelled `ready-for-agent` first, then sidebar project
  order, then lowest issue number. Clicking a row starts work the same way the
  palette's issue detail does (NewWorkspaceDialog prefilled with branch,
  prompt and linked issue), through a shared helper extracted from
  `GitHubIssueDetailView` / the Linear equivalent. The header has an "All
  issues" link that opens the palette's issue list for the selected project.
- **Summary line:** "N agents running · N open PRs · N issues ready". Plain
  text in v1, and a segment is omitted when it is 0.
- **Nothing pending:** Needs you and Up next are both empty, so a single dim
  "Nothing needs you" row replaces them.

All ranking lives in pure functions in `src/lib/home-dashboard.ts`, with
Vitest tests next to `pr-readiness.test.ts`. The component only wires store
state in. Rows use `<Button variant="ghost">` with the shell's row class (per
`.claude/rules/ui-components.md`). `EmptyStateShell` gains a `children` slot
rendered under the launchers, and its own raw `<button>` moves to `<Button>`.

### 2. Projects overview surface

A new app-level surface, **not** a workspace path. `useAppStore` gains
`activeSurface: "workspace" | "projects"` (default `"workspace"`) and
`showProjectsOverview()`. `setActiveWorkspace`, `addTab`, `addBrowserTab`
and `navigateToContext` reset it to `"workspace"`. That way a launcher or
shortcut pressed while the overview is open lands in the underlying workspace
as today. A sentinel path was rejected: `setActiveWorkspace` would create and
persist an empty `WorkspaceLayout` for it, tabs could open "inside" it, and
every `isHomePath` site (about 20, listed in the research) would need a second
branch.

- **App.tsx:** when `activeSurface === "projects"` **or** there are zero
  projects, render `<ProjectsOverview>` in the main area, ahead of the
  wizard / Home / workspace empty-state ternary. The wizard still wins. It is
  opened right after a project is added, which also flips the surface back.
- **Sidebar:** the Projects heading becomes a row like Home
  (`data-testid="projects-row"`, `data-sidebar-row`, `tabIndex={-1}`,
  `aria-current` when the overview is shown, `handleSidebarRowKeyDown`), and
  keeps its context menu. Home and project rows lose `aria-current` /
  selection while the overview is shown.
- **Navigation history:** `Location` gains `{ kind: "surface", surface:
  "projects" }`. `selectCurrentLocation` and `applyLocation` handle it.
- **Not persisted:** relaunching restores the last workspace or Home as today.

`ProjectsOverview` (`src/components/projects-overview/`) renders:

- **Header:** "Projects" plus "N projects · N hosts".
- **Cards,** one per `buildTopLevelEntries(projects)` entry (a linked group is
  one card). Each card shows:
  - the name, in the project color when set (`projectColorStyle`)
  - a host badge (`memberHostName` per member, joined with " + ")
  - the path (of the `lastUsedHostId` member for a group)
  - counts: needs you (red, only when > 0), workspaces (non-hidden), agents
    running, open PRs
  - up to 3 workspaces that have something pending, using the Needs-you tier
    labels, or "Nothing open"

  Clicking a card selects the project and its selected workspace. The card
  data comes from a pure `projectCardSummary()` in `home-dashboard.ts`.
- **Add a project:** section rows in the same style as the Home launchers:
  - **"Open a folder"** → `handleAddLocalProject` (directory picker directly)
  - **"Clone onto a remote host"** → `AddProjectDialog` with a new
    `initialMode="remote"` prop
  - a **drop zone** → `handleDropFolder`

### 3. Onboarding consolidates into the overview

With zero projects, App renders `ProjectsOverview` (the logo above an empty
"Add a project" section) instead of `WelcomeEmptyState`. `WelcomeEmptyState`
and its CSS are deleted. The `import-project-button` test id moves to the
"Open a folder" row. The e2e fixture `importSeededProject`
(`tests/e2e/fixtures.ts:294`) is updated, because that row now opens the
directory picker directly instead of the dialog. `remote-host.spec.ts` goes
through "Clone onto a remote host".

## Consequences

**Better**
- Home answers "what needs me / what's next" across all projects, with rules
  that are unit-tested and agree with the sidebar indicators (same
  `prReadiness` and status tiers).
- One place to see and add projects, and onboarding stops being its own
  one-off screen.

**Harder / risks**
- **Ordering is approximate.** `PaneAgentStatus` has no timestamp, so
  `AgentInfo.updatedAt` is only a proxy for "waiting since". A real
  `statusSince` needs a reconciler change (ADR-184) and is out of scope.
- **Possible bug in `requires_input`.** The research flags that the
  reconciler's stuck-working rule may flip `requires_input` → `responded`
  after 60s (`electron/agent-status/reconciler.ts:103`). If that's real, the
  top tier undercounts. It's not fixed here; the reconciler is out of scope,
  and it gets verified separately.
- **Coverage gaps.** PRs only appear for branches that have a local
  workspace. Review requests aren't shown at all. Both need the v2
  main-side GraphQL poller.
- **Up next costs API calls.** It adds one `gh issue list` per project per
  minute while Home is visible (React Query pauses when unmounted). That's
  fine for a handful of projects, but many projects would want the v2 poller.
- **Sidebar keyboard order changes.** It becomes Home → Projects → project
  rows, so the keyboard-navigation e2e specs need updating.
- **Existing shortcut change.** ⌘T / ⌘N from the overview open a tab in the
  previously active workspace rather than in "the overview".

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
