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

# ADR-198: Full Home dashboard ("Studio")

## Context

Home (ADR-194, ADR-197) is a 480px column of list rows under the Manor logo:
Needs you, Up next, Open PRs and a summary line. It answers "what's next" but
not "how is everything going". It also leaves out data Manor already holds:
diff sizes, failing check names, host status, dev server ports, stats, and
how agents have spent their time.

`docs/research/home-dashboard-data-points.md` inventories that data and ranks
it. We then iterated on mockups (`mockup.html` in this folder, published at
https://claude.ai/artifact/WGiAnvYYj13dsizxHtD6Sv). The user picked the
**Studio** style: soft panels in Manor's own palette, a headline sentence,
stat tiles with small charts, Needs you as action cards, an agent activity
timeline, a PR pipeline, Up next and project tiles. `mockup.html`'s default
style is the target. Ignore its `calm` / `terminal` / `mission` overrides and
the style switcher.

Constraints found while researching:

- **No GitHub PR merge API.** `quickMergeWorktree` merges a worktree locally
  into the default branch. It is not a GitHub merge. The mockup's "Merge"
  button therefore can't ship as a PR merge yet.
- **No approval text for agent prompts.** A `requires_input` agent reaches the
  renderer only as a status. The permission prompt's tool/command is not
  captured, so "Approve" from Home is out of scope.
- **No agent status history.** `agent-status` pushes the current status only
  (`src/electron.d.ts:283-288`). Nothing records when a pane changed status, so
  the timeline needs a new recorder.
- **PR `updatedAt` is fetched and then dropped** (`electron/github.ts:209` vs
  the `PrInfo` build at `:257-275`).
- **Stats keep per-day buckets in main** (`electron/stats-store.ts:79`), but
  the summary only sends `today` / `last7Days` / `allTime` totals, plus a
  per-day prompt series.
- **Ports live in component state.** `usePortsData`
  (`src/components/ports/usePortsData.ts:15`) runs its own scanner inside the
  sidebar's `PortsList`.
- Linear `priority` is on every Linear issue (`src/electron.d.ts:184`), but
  `rankUpNext` ignores it.

## Decision

Replace Home's list dashboard with a full-width, scrollable dashboard that
matches `mockup.html` (Studio). It still renders where `HomeDashboard` renders
today: inside `HomeEmptyState`, when Home has no tabs. Where the dashboard
lives permanently is a separate decision.

### 1. Layout

- `HomeEmptyState` stops using `EmptyStateShell`'s 480px centred column for
  the dashboard. It renders a new `HomeDashboard` page: `max-width: 1180px`,
  centred, scrolling vertically, with a 12-column grid that stacks to one
  column below 900px (container query on the Home pane, not a viewport query,
  because the sidebar takes width).
- Sections, top to bottom:
  1. **Header.** Date eyebrow; a headline sentence ("3 things need you. 3
     agents are working and 5 PRs are with reviewers."); buttons New agent
     (⌘N), Open terminal (⌘T) and Command palette (⌘K). These replace
     `EmptyStateShell`'s launcher rows.
  2. **Host alert strip.** Shown only when a host is offline or failing, with
     the affected workspace count and Reconnect (`retryConnect`).
  3. **Stat tiles (4).**
     - *Waiting on you:* count, longest wait, sparkline.
     - *Agents working:* count, sparkline.
     - *Open PRs:* count, oldest age, a stacked stage bar with a legend.
     - *Merged this week:* count, and bars per day.
  4. **Needs you cards**, in a grid. Each card has kind, project, age, title, a
     context block, a primary action, a secondary action and Snooze.
  5. **Agent activity**: a lane per agent over the last 3 hours, showing
     working / thinking / waiting-on-you / finished / errored.
  6. **Pull requests pipeline**, with columns Checks running / In review /
     Blocked / Ready.
  7. **Up next** (left) beside the pipeline (right), 7/5 split.
  8. **Project tiles**: a block per workspace coloured by its most urgent
     state, host status, diff totals and dev server port.
- Style: Manor's existing tokens (`--bg`, `--surface`, `--hover`, `--border`,
  `--text-*`, `--accent`, plus the state colours used by `TIER_COLOR`). The
  font is the app's font; don't add the mockup's Geist. Panels get radius 14,
  a 1px border and a soft shadow. Use existing `ui/` components (`Button`,
  `Tooltip`, `CountBadge`, `Link`) per `.claude/rules/ui-components.md`.
  Charts are hand-written inline SVG. No chart library.

### 2. Data

New pure selectors go in `src/lib/home-dashboard.ts`, or in a sibling
`src/lib/home-dashboard-*.ts` if that file gets too big. Each has unit tests.

- **Pipeline stage per open PR (`prStage`).**
  - `checks`: pending with `checks.pending > 0`.
  - `review`: `review`, and `pending` drafts with no running checks, labelled
    "draft".
  - `blocked`: `blocked`, with the reason from the existing `blockedReason`.
  - `ready`: `ready` and `queued` (queued is tagged).
  - Each PR appears once in the pipeline. A blocked or ready PR *also* appears
    as a Needs you card. The pipeline is the inventory; Needs you is the
    to-do list. Same rule as ADR-197.
- **Needs you cards** extend `needsYouItems` with context:
  - Failing check names from `pr.checkRuns`: the first failing run, plus "+N".
  - Conflicts and changes-requested reasons.
  - Unresolved thread count.
  - For finished agents, the workspace's `diffStats` (+/−).
  - Agent errors show the pane title.
  - Tier order is unchanged (ADR-194).
- **Headline sentence** built from counts. Zero states read naturally ("Nothing
  needs you.").
- **Stat tile data.** The two sparklines come from the activity recorder (§3).
  Merged-this-week comes from a new `dailyPrsMerged` series.
- **Project tile summary** per top-level entry:
  - Workspace blocks coloured by their most urgent state (needs you > running >
    PR ready > idle).
  - Summed `diffStats`.
  - Host status via `describeHost` / group host state.
  - First listening port.
- **Up next ranking.** `rankUpNext` gains Linear `priority` as a tiebreaker
  after `ready-for-agent` (Urgent 1 → Low 4, then 0 = none last). Rows show a
  priority glyph.

Main-side changes, each small:

- `PrInfo.updatedAt?: string`, kept from the existing fetch. It enables PR ages
  and the stale highlight (≥ 1 day).
- `StatsSummary.dailyPrsMerged: { day: string; count: number }[]` for the last
  7 local days, including zeros, built from the day buckets in
  `electron/stats-store.ts`.

### 3. Agent activity recorder (renderer)

- A new zustand store, `src/store/agent-activity-store.ts`. It subscribes to
  `useAppStore`'s `paneAgentStatus` and appends
  `{ paneId, status, at: Date.now() }` whenever a pane's status changes.
- It prunes entries older than 3 hours, and caps each pane's list.
- Every 5 minutes it samples the counts of "waiting on you" and "working"
  agents, keeping 3 hours, for the two sparklines.
- It lives in memory only. After a reload, the timeline starts from that
  moment and the axis shows "since HH:MM". Persisting history in main can
  come later.

### 4. Actions

| Card / row | Primary | Secondary |
|---|---|---|
| Agent needs input | Focus agent (`navigateToAgent`) | none |
| Agent errored | Focus agent | Open workspace |
| PR checks failing | Fix with agent: `startAgentWithPrompt` in the workspace with a prompt naming the failing checks and their URLs | View check (`Link` to the run URL) |
| PR conflicts / changes requested / threads | Open workspace | Open PR |
| Agent finished | Review: focus agent (marks it seen) | Open diff |
| PR ready to merge | Open PR (GitHub merge happens there) | Open workspace |
| Pipeline card | Open workspace | PR badge opens the popover |
| Up next row | Start agent (existing `useStartUpNextIssue`) | none |
| Project tile | Select the project's first workspace that needs you (else its selected one) | none |

- **Snooze.** Hides a Needs you card for 1 hour. It is kept in a small
  `localStorage`-backed store keyed by the card's item key, and expired
  entries are dropped on read. Snoozed cards don't count towards "Waiting on
  you".

### Out of scope

- Approve/deny agent prompts from Home.
- GitHub PR merge from Home.
- Review requests on PRs without a workspace.
- "Whose move" thread detection (it needs `last: 1` on review threads).
- Making the dashboard a permanent surface.
- A light-theme review: the app is dark-first. Tiles use tokens, so they
  follow whatever theme the app applies.

## Consequences

**Better**

- Home becomes a real overview. You can see status, bottlenecks and throughput
  at a glance, and each card carries enough context to act without opening
  the workspace first.
- Data we already fetch (check names, diff stats, host state, ports, Linear
  priority, PR `updatedAt`) finally reaches the user.
- The whole dashboard is pure selectors plus presentational components, so
  most logic is unit-tested without Electron.

**Harder / risks**

- **Timeline history is lost on reload.** Timelines and sparklines start
  empty. Mitigation: the "since HH:MM" axis label, and a later ADR can move
  history into main.
- **Double port scanning.** Using `usePortsData` a second time would start a
  second scanner. Ticket 7 lifts the port list into a shared store fed by a
  single scanner.
- **Density.** With many projects and PRs the page gets long. Caps: 6 Needs
  you cards then "+N more"; 3 cards per pipeline column then "+N more"; 6
  timeline lanes, preferring agents that need you or are active; 5 Up next
  rows.
- **ADR-194's single-column launcher is replaced.** The ⌘N / ⌘T / ⌘K rows
  become header buttons.
- **Old dashboard code goes away.** The list-row `HomeDashboard` sections, the
  summary line and the Open PRs widget from ADR-197 are removed. Their
  selectors (`openPrRows`, `topUpNextPerProject`, the `up-next` palette view)
  stay in use.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
