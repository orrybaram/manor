# Research: Home dashboard data points and how to display them

**Question.** Which data does Manor hold about projects, workspaces, PRs,
agents, issues, hosts and processes? Which of it matters most, and how should a
full Home dashboard show it so the user can understand it quickly and act on it?

**Method.** I read the source under `src/` and `electron/` on branch
`feat/adr-197-home-up-next-and-open-prs` (commit `8417b9d2`). File:line
references point at that tree. I also read the earlier note
`docs/research/home-dashboard.md` (called **R1** below), ADR-194 and ADR-197.
Design guidance comes from primary sources (GitHub, Linear, NN/g, Stephen Few,
W3C), with links given. I did not run the app.

**Relation to earlier work.** R1 §2–§4 already lists most of the data sources
and proposes candidate widgets. ADR-194 shipped Needs you, Up next and a summary
line. ADR-197 added Up next per project and an Open PRs list. This note does not
repeat those. It re-checks the facts against the current code, adds the data
points R1 left out, ranks everything, and proposes an information architecture
for a *full* dashboard. Places where this note disagrees with a decision are
marked **⚠ conflict**.

---

## TL;DR: the top 8 data points (importance × actionability)

1. **Agent waiting on you (`requires_input`)**
   (`src/electron.d.ts:264-270`, joined in `src/lib/home-dashboard.ts:114-135`).
   While it waits, the agent does nothing. It is the only signal where the
   user's delay costs agent time directly, and the fix is one click: focus the
   pane.
2. **PR "whose move" state**, derived from `prReadiness` plus
   `recentComments[].isViewer/isBot` (`src/lib/pr-readiness.ts:17-72`,
   `src/lib/pr-info.ts:22-54`). Among blocked PRs, it separates *your move*
   (CI failed, changes requested, a thread whose last word is someone else's)
   from *their move* (review required) and *the machine's move* (checks
   running, queued). GitHub's own PR dashboard now sorts its inbox along the
   same lines ([GitHub changelog, 2026-07-09](https://github.blog/changelog/2026-07-09-new-pull-requests-dashboard-is-now-generally-available)).
3. **Failing check names** (`PrInfo.checkRuns`, `src/lib/pr-info.ts:62-70`).
   These are already fetched. "lint failing" can be acted on; "1 failing" cannot.
   Home rows currently show only the count label.
4. **Agent errored (`error`)** (`src/electron.d.ts:269`). The agent has stopped.
   It is the same kind of signal as #1, and the action is the same.
5. **Agent finished and unseen** (`unseenRespondedAgentIds`,
   `src/store/agent-store.ts:25`). An agent's output waits for review. This
   decides whether the *next* turn starts.
6. **Ready to merge** (`prReadiness === "ready"`, `src/lib/pr-readiness.ts:62-69`).
   This is finished work waiting on one click. Quick merge already exists
   (ADR-077), but Home doesn't offer it (ADR-194 §1: "The dashboard does not
   merge").
7. **Live agent activity: running count, name/title and age**
   (`AgentInfo.name/createdAt/updatedAt`, `src/electron.d.ts:49-75`;
   `paneTitle`, `src/store/app-store.ts:264`). This is ambient awareness:
   "is my fleet busy?" There is no action unless something stalls. Its value
   is reassurance, and it keeps the user from interrupting working agents.
8. **Up next issues with priority** (Linear `priority`, `electron/linear.ts:137`;
   GitHub `labels`, `electron/github.ts:371`). This is the supply of new work.
   Linear priority is fetched but **ignored by `rankUpNext`**
   (`src/lib/home-dashboard.ts:262-282`).

Close runners-up: **diff size** per workspace (`diffStats`, which shows how
much unreviewed agent output is sitting there), **host offline**
(`src/store/host-store.ts:4-31`), and **clean-up candidates** (merged/closed PR
on a workspace that still exists).

---

## 1. Data inventory

Freshness key: *push* means main sends it on change. *poll Ns* means it is
polled every N seconds (the poller is named). *on-demand* means it is fetched
only when requested.

Scope key: G = global, P = per project/group, W = per workspace, A = per
agent/pane, PR = per pull request.

### 1.1 Projects, workspaces, hosts

| Data point | Source (file:line) | Freshness | Scope | Currently shown? | Primary action |
|---|---|---|---|---|---|
| Project identity: name, color, host, path, default branch | `electron/projects/types.ts:66-106` | push `projects-changed` + window focus (R1 §2.1) | P | Sidebar; Projects overview card (`src/components/projects-overview/ProjectCard.tsx:34-46`) | Select project |
| Linked group (one repo on several hosts) | `electron/projects/types.ts:122-130` | push | P | Sidebar group, overview card | Dedupe rows by repo |
| Workspace path / branch / isMain / name / hidden / folder | `electron/projects/types.ts:38-46`; renderer `src/store/project-store.ts:407-417` | worktree list push (local `fs.watch`) / poll 10s remote (`electron/projects/worktree-watcher.ts:139,162`); branch poll 2s local / 5s remote (`electron/branch-watcher.ts:75`) | W | Sidebar rows | Open workspace |
| Linked issues per workspace | `src/store/project-store.ts:416,419-424`; storage `electron/projects/workspace-folders.ts:317-320` | push | W | Sidebar; used by Up next to hide linked issues | Open the issue |
| Diff stats vs default branch (+/−) | `src/store/project-store.ts:339-342,1729-1748`; poller `electron/diff-watcher.ts:35` | poll 5s | W | Sidebar row (`src/components/sidebar/ProjectItem.tsx:238-262`); **not on Home** | Open diff pane |
| Run command / custom commands | `electron/projects/types.ts:75,86`; `src/store/project-store.ts:333-337` | push | P | Palette (`src/components/command-palette/useCustomCommands.tsx:37`), settings | Run the command |
| Host connection status, failure, retry time | `src/store/host-store.ts:4-31` | push `hosts:statusChanged` (R1 §2.1) | G/host | Sidebar/host UI via `describeHost` (`src/lib/host-status.ts:56`); **not on Home** | Retry connect (`retryConnect`, host-store) |
| Group host state (connected / partially offline / offline) | `src/lib/host-status.ts:168-174` | derived | P | Sidebar group | Reconnect |

### 1.2 Agents

| Data point | Source | Freshness | Scope | Currently shown? | Primary action |
|---|---|---|---|---|---|
| Live pane status `idle/thinking/working/requires_input/error/responded` | `src/electron.d.ts:264-288`; store `src/store/app-store.ts:265` | push `agent-status` (reconciler, ADR-184) | A | Sidebar dots; Home Needs you (input/error/finished tiers, `src/lib/home-dashboard.ts:114-135`); Home summary count | Focus pane (`navigateToAgent`) |
| Unseen responded / unseen requires-input sets | `src/store/agent-store.ts:25-27` | push `agent-updated` | A | Sidebar `done_unread`; Home "finished" tier | Focus pane, which marks it seen |
| Agent record: name, kind, command, created/updated/completed/activated/resumed timestamps, lifecycle status, project/host/workspace/pane | `src/electron.d.ts:49-75` | push | A | Palette agent list (`src/components/command-palette/useAgentCommands.tsx:60`); Home shows age from `updatedAt` on Needs you rows (`HomeDashboard.tsx` `formatAge`) | Focus / resume / rename |
| Pane title (the agent sets the terminal title; it feeds `AgentInfo.name` unless the name is pinned) | `src/store/app-store.ts:264`; `src/electron.d.ts:69-73` | push | A | Tab titles | "What is it doing" text |
| Status reason (diagnostic string) | `src/electron.d.ts:276-281`; reasons e.g. `electron/agent-status/reconciler.ts:811,983` | push | A | Tooltip on `AgentDot` (`useAgentCommands.tsx:60`) | Debugging only; not for Home |
| Last hook time (monotonic), active subagents, open tool calls | `electron/agent-status/types.ts:75-116` | main memory only | A | **Not exposed to the renderer** | Would allow "quiet for N min" and "N subagents running" |
| Agent kinds | `src/electron.d.ts:255` (`claude/opencode/codex/pi`) | static | A | Icons | — |

**Correction to R1 §2.6 on the T2 risk.** R1 warned that the stuck-working
rule could turn `requires_input` into `responded` after 60s. The current
reconciler waits `STALE_SUBAGENT_MS` (15 min) while a root tool call is open
(`electron/agent-status/reconciler.ts:973-976,98-104`). A permission prompt
arrives between PreToolUse and PostToolUse, so an open tool call is the usual
case. So the risk now applies after about 15 minutes, not 60 seconds, for prompts
raised during a tool call. I inferred this from reading the code and did not
test it. `requires_input` is still in `ACTIVE_STATUSES` (`:112-116`), so a
prompt that waits more than 15 minutes can still drop out of the top tier.
**That is exactly the case Home most needs to catch.**

### 1.3 Pull requests (per workspace branch)

| Data point | Source | Freshness | Scope | Currently shown? | Primary action |
|---|---|---|---|---|---|
| number, state, title, url, isDraft, +/− | `src/lib/pr-info.ts:72-80`; fetch `electron/github.ts:208-209` | poll 60s in the renderer (`src/hooks/usePrWatcher.ts:14`), non-main workspaces only (`:30-32`) | PR/W | Sidebar badge + popover; Home Open PRs rows | Open workspace / open PR |
| reviewDecision | `src/lib/pr-info.ts:81` | same | PR | Popover; readiness label | Request review / address |
| Checks summary (passing/failing/pending/skipped) | `src/lib/pr-info.ts:6-17` | same | PR | Popover; label "checks failing" | Open failing run |
| **Named check runs with URL and workflow** | `src/lib/pr-info.ts:62-70`, failing first (`:91`) | same | PR | Popover only (`src/components/sidebar/PrPopover.tsx:452`); **not on Home rows** | Open the failing run's log |
| Unresolved threads, comment count | `src/lib/pr-info.ts:83-84`; GraphQL `electron/github.ts:327` | cached per URL until `updatedAt` changes or 5 min (`electron/github.ts:55,282-305`) | PR | Popover; "N unresolved threads" label | Open thread |
| Recent comments: author, body, url, kind, reviewState, path, isResolved, isOutdated, **isBot, isViewer** | `src/lib/pr-info.ts:22-54,86-90` | same | PR | Popover list (`PrPopover.tsx:543`) | Reply / open comment |
| queuedToMerge (auto-merge or merge queue) | `src/lib/pr-info.ts:92-98`; `electron/github.ts:237-238` | same | PR | Badge "queued" | None: wait |
| hasConflicts | `src/lib/pr-info.ts:99-105`; `electron/github.ts:245` | same | PR | Badge/label "conflicts" | Rebase (agent prompt) |
| Readiness tier `blocked/queued/review/ready/pending/merged/closed` | `src/lib/pr-readiness.ts:17-72` | derived | PR | Sidebar badge colour; Home Needs you / Open PRs order (`src/lib/home-dashboard.ts:379-425`) | Depends on tier |
| **PR `updatedAt`** | requested in `--json` (`electron/github.ts:209`) and used for the cache key (`:286-293`) | — | PR | **Dropped. Not in `PrInfo`** (`electron/github.ts:259-276`) | Staleness / "waiting since" |
| PR merged event → stats counter | `electron/github.ts:247-255`; `electron/app-lifecycle.ts:445` | on poll | G | Stats view | — |

Not fetched at all: PR `createdAt`, author, requested reviewers, `headRefName`
for PRs that have no workspace, and review requests addressed to the user. R1
§3.1 already shows that one GraphQL search returns these at a cost of 1 point.

### 1.4 Issues

| Data point | Source | Freshness | Scope | Currently shown? | Primary action |
|---|---|---|---|---|---|
| GitHub issue: number, title, url, state, labels, assignees (assigned to me) | `electron/github.ts:355-379`; type `src/electron.d.ts:200-207` | poll 60s while Home is mounted (`useUpNextIssues.ts:16,121-127`) | P | Home Up next (3 per project); Up next palette view | Start work (new workspace + agent) |
| Linear issue: identifier, title, url, **branchName, priority, state{name,type}**, labels | `electron/linear.ts:121-139`; type `src/electron.d.ts:178-187` | poll 60s, `unstarted`+`backlog`, limit 10 (`useUpNextIssues.ts:141`) | P | Same | Start work |
| Linear `updatedAt` ordering | query orders by it (`electron/linear.ts:129`) but does not select it | — | — | No | Age |
| Issue detail (body, milestone, assignee) | `electron/github.ts:411-431`; `src/electron.d.ts:189-222` | on-demand | issue | Palette detail | — |

### 1.5 Notifications, stats, ports, processes, misc

| Data point | Source | Freshness | Scope | Currently shown? | Primary action |
|---|---|---|---|---|---|
| Notification log (kind, title, body, **timestamp**, read, target, comment) | `src/electron.d.ts:82-107`; capped at 200 / 30 days (`electron/notification-store.ts:52-54`) | push | G | Bell popover | Jump to target |
| Usage stats: prompts, tool calls, sessions, subagents, blocks/unblocks, **unblock latency**, worktrees created/merged, PRs merged, PR approvals / changes requested / checks failed, max concurrent agents, weekly streak, daily prompts | `src/electron.d.ts:114-158`; `src/store/stats-store.ts:51` (`formatUnblockLatency`) | push `stats:changed`, debounced 1s (`electron/ipc/stats.ts:12`) | G only | Palette Stats view with contribution grid (`src/components/command-palette/StatsView.tsx:143`) | None (reflection) |
| Listening ports: port, process, pid, workspace, portless hostname, host | `src/electron.d.ts:224-235`; poll 3s (`electron/ports.ts:37`) | poll 3s | W | Sidebar `PortsList` (`src/components/sidebar/Sidebar/Sidebar.tsx:314`); held in component state (`src/components/ports/usePortsData.ts:15`) | Open preview URL / kill port |
| Daemon, internal servers, sessions with an `orphaned` flag | `src/electron.d.ts:236-253` (`ManorProcessInfo`) | on-demand | G | Process UI / CLI | Clean up orphans |
| Inline review drafts per workspace (unsent comments) | `src/store/review-store.ts:3-15,19` | renderer memory | W | Diff pane | Submit review to agent |
| Remote-control / tunnel status | `src/electron.d.ts` `TunnelStatus`, `RemoteControlStatus` (`:1262,1280`) | push | G | Settings | — |

---

## 2. Unsurfaced and cheap-to-derive signals

Ordered by value to Home. Cost: **R** = a pure selector over data already in
the renderer; **S** = a small main-side change; **N** = a new fetch.

1. **"Whose move" for each open PR (R).** Split `prReadiness` into three buckets:
   - *You:* `checks.failing > 0`, `hasConflicts`, `CHANGES_REQUESTED`, or an
     unresolved thread whose newest comment has `!isViewer && !isBot`.
   - *Others:* `review`, or an unresolved thread whose last comment
     `isViewer`.
   - *Machine:* `pending` with `checks.pending > 0`, or `queued`.

   Today `blocked` lumps a thread you already answered together with a red CI
   (`src/lib/pr-readiness.ts:25-29`). `recentComments` is newest-first and
   includes threads (`src/lib/pr-info.ts:86-90`), so this needs no new fetch.
   ⚠ The first review-thread comment is what gets fetched
   (`reviewThreads … comments(first: 1)`, `electron/github.ts:327`), not the
   last. "Who spoke last in a thread" therefore needs `last: 1` on that
   connection (**S**).
2. **Failing check names on the row (R).** Show `checkRuns.filter(failing)[0].name`
   plus "+N", and link to its `url`.
3. **Bot vs human comments (R).** `isBot` already exists. Count unread human
   comments separately, so a Dependabot or CI comment doesn't escalate a PR.
4. **Unreviewed agent output = `done_unread` × `diffStats` (R).** "Agent
   finished · +412 −38" tells the user how big the review will be. Diff stats
   are live every 5s but absent from Home.
5. **Clean-up candidates (R, partial).** A workspace whose `pr.state` is
   `merged` or `closed`, with no running agent. R1 §4.6 proposed this, but
   ADR-194/197 did not ship it. A dirty check still needs **S** (R1 §3.2).
6. **Workspace with no PR but a non-zero diff (R).** "+230 on a branch with no
   PR" is a "push & open PR" candidate. This is a subset of R1 §4.7 that needs
   no git poller.
7. **Linear priority in ranking (R).** It is already on every Linear row
   (`electron/linear.ts:137`) and already used for Linear's own sort
   (`:155-156`). `rankUpNext` ignores it. Linear's own My Issues orders "by
   priority, with started issues showing first" within focus groups
   ([Linear docs: My Issues](https://linear.app/docs/my-issues)).
8. **PR age / staleness (S).** Keep `updatedAt` in `PrInfo`. The value is
   already fetched and then dropped (`electron/github.ts:209` vs `:257-275`).
   This gives "no activity for 5d" and a real within-tier order for Open PRs.
9. **"Waiting since" for agents (S).** Publish a `statusSince` with
   `agent-status`. Until that exists, the newest unread `agent-requires-input`
   notification `timestamp` for that agent is a better proxy than
   `AgentInfo.updatedAt`, which moves on any update (R1 §2.6).
10. **"Quiet for N min" / subagent count (S).** Expose `lastHookAt` and
    `activeSubagents.size` (`electron/agent-status/types.ts:88,106`). Both are
    already held for each pane. "Working · 3 subagents · quiet 4m" separates a
    busy agent from a stuck one.
11. **Dev servers per workspace (R once lifted).** Ports are known per
    workspace, but they live in `usePortsData` local state
    (`src/components/ports/usePortsData.ts:15`). A Home row could show a
    `:5173` chip that opens the preview.
12. **Host offline impact (R).** "devbox offline · 3 workspaces · 1 agent"
    uses `isHostOffline` (`src/lib/host-status.ts:152`) joined with projects.
13. **Throughput trend (R).** `StatsSummary.last7Days` vs `today`
    (`src/electron.d.ts:146-158`) for PRs merged, agents responded, and unblock
    latency. These are reflection metrics, not action metrics; see §3.
14. **Review requests / PRs without a workspace (N).** This is R1 §4.4, and it
    remains the biggest coverage gap.

---

## 3. Dashboard design principles, applied to Manor

**P1. A dashboard is for conditions that need a timely response.** Few's
revised definition: "a predominantly visual information display that people use
to rapidly monitor current conditions that require a timely response to fulfill
a specific role"
([Few, Perceptual Edge blog](https://www.perceptualedge.com/blog/?p=2793)).

*Applied:* rank by how quickly the user's response matters. First the agents
blocked on the user, then PRs where it is the user's move, then work that is
done and waiting. Stats (streaks, contribution grid) fail this test. Keep them
in the palette's Stats view and at most show a one-line trend.

**P2. Aim for one screen and highlight what matters.** Few's original definition
calls for information "consolidated on a single computer screen so it can be
monitored at a glance" (same source). His list of common pitfalls includes
exceeding a single screen, excessive detail or precision, and failing to
highlight important data
([Few, *Common Pitfalls in Dashboard Design*](https://www.perceptualedge.com/articles/Whitepapers/Common_Pitfalls.pdf);
I could not extract the PDF text, so this list comes from
[secondary summaries](https://www.thedataschool.co.uk/anh-vu/are-you-making-these-13-dashboard-design-mistakes/)).

*Applied:* ⚠ **conflict with ADR-197 §Consequences**, which accepts that "Home
gets longer" at 3 issues × N projects. At 10 projects, that is up to 30 Up next
rows above Open PRs. Cap each section, and give the page an above-the-fold
budget (§4.2).

**P3. Dashboards are for consumption, not exploration.** NN/g: "Their goal is
not to facilitate exploration; instead, they provide information that can be
consumed fast, with a minimum of interaction or cognitive processing." For
quantities, use length and 2D position rather than area; avoid pies and donuts
([NN/g, Dashboards: preattentive](https://www.nngroup.com/articles/dashboards-preattentive/)).

*Applied:*
- Rows should read in a fixed column order: *state icon → object → reason →
  age → one action*.
- If Manor shows diff size or check progress, use a small bar (length), not a
  ring.
- Deeper exploration stays in the popover and the palette views.

**P4. Progressive disclosure.** "Initially, show users only a few of the most
important options", and offer the rest on request
([NN/g, Progressive disclosure](https://www.nngroup.com/articles/progressive-disclosure/)).

*Applied:* the "N more" expanders (ADR-194/197) are correct. The next level
down is the existing `PrPopover` (checks, comments), and the level after that
is the palette view. Home should not re-implement either.

**P5. Indicators belong next to their object.** Indicators "are contextual …
shown in close proximity to that element" and "passive"
([NN/g, Indicators, validations, notifications](https://www.nngroup.com/articles/indicators-validations-notifications/)).

*Applied:*
- Put CI, review, port and diff chips *on the workspace/PR row*, not in a
  separate "CI" panel.
- The notification bell stays the place for events. Home shows **state**
  (what is true now), not an event feed. R1 §4.10 reached the same conclusion.

**P6. Don't rely on colour alone.** WCAG 1.4.1: "Color is not used as the only
visual means of conveying information…"
([W3C, Understanding SC 1.4.1](https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html)).

*Applied:* Home's tier colours (`TIER_COLOR` in `HomeDashboard.tsx`) must stay
paired with an icon and a text label. The current rows do this; keep it for
any new chips.

**P7. Show system status, including staleness.** "Systems should always keep
users informed about what is going on, through appropriate feedback within
reasonable time"
([NN/g, Visibility of system status](https://www.nngroup.com/articles/visibility-system-status/)).

*Applied:*
- Show "updated 40s ago" for PR data, which is a 60s poll
  (`usePrWatcher.ts:14`).
- Show "host offline, last known" for remote rows.
- Show "gh not authenticated" instead of silently empty sections.
  `useUpNextIssues` skips failed sources silently (ADR-194 §1). An empty
  section is ambiguous unless it says why.

**P8. Empty states should explain and give a way forward.** "Tell the user
what could be displayed, and how to populate the area with that content"
([NN/g, Empty states](https://www.nngroup.com/articles/empty-state-interface-design/)).

*Applied:* every section needs a specific empty state (§4.3). "Nothing needs
you" is right for the attention queue. Up next with Linear not connected should
say so, with a Connect action.

**P9. Prior art: triage by *reason*, and let users reorder or hide.**
- GitHub's PR dashboard Inbox (GA July 2026) "surfaces your review requests,
  pull requests that need fixing (e.g., CI failures or new comments), and pull
  requests that are ready to merge or in the merge queue". Users "can reorder
  or hide sections"
  ([GitHub changelog](https://github.blog/changelog/2026-07-09-new-pull-requests-dashboard-is-now-generally-available)).
- GitHub notifications classify by `reason:` (`review-requested`,
  `ci-activity`, `author`, `mention`, …)
  ([GitHub docs: inbox filters](https://docs.github.com/en/subscriptions-and-notifications/reference/inbox-filters)).
  Triage verbs are Done / Save / Unsubscribe
  ([GitHub docs: managing notifications](https://docs.github.com/en/subscriptions-and-notifications/how-tos/viewing-and-triaging-notifications/managing-notifications-from-your-inbox)).
- Linear's Assigned tab groups by "focus": urgent, SLA-bound, blockers, cycle,
  other active, triage, backlog, completed. "Some sections only appear when
  they apply" ([Linear docs: My Issues](https://linear.app/docs/my-issues)).
- Linear Inbox offers snooze and separates Priority from Other
  ([Linear docs: Inbox](https://linear.app/docs/inbox)).

*Applied:*
- Manor's Needs you tiers are the same idea as a focus order. Keep them.
- Hide empty sections, which Manor already does.
- Add a **snooze/dismiss** for PR items that are "their move". Otherwise a PR
  waiting days on a reviewer sits on Home permanently.
- Consider user-reorderable sections later. Both GitHub and Linear support
  customization.

---

## 4. Proposed information architecture

### 4.1 Sections in priority order

The model is **"whose move is it?"**: the user, the agents, or other people and
CI. It extends ADR-194's Needs you to agents and to PRs, and it keeps each row
to one action.

| # | Section | Shows | Row anatomy | One action per row | Source (cost) |
|---|---|---|---|---|---|
| 0 | **Status strip** (one line, only when something is wrong) | `gh` unauthenticated, Linear disconnected, hosts offline (with the count of affected workspaces), data staleness | icon · text · fix link | Fix (Settings / Retry connect) | host-store, `github:checkStatus` (R) |
| 1 | **Your move** (was Needs you) | Tiers: agent input → agent error → PR checks failing / conflicts / changes requested / thread awaiting your reply → agent finished unseen (with diff size) → PR ready to merge | tier icon · project chip · workspace · reason incl. failing check name · age | Agents: focus pane. PR fix: open workspace. Ready: open workspace (merge button optional; see Q3) | existing + §2 items 1–4 (R/S) |
| 2 | **Agents at work** | `thinking` / `working` agents: name/title, workspace, running time, later "quiet Nm" and subagent count | status dot · name · workspace · duration | Focus pane | `useAgentStore`, `paneAgentStatus`, `paneTitle` (R); quiet/subagents (S) |
| 3 | **Waiting on others** | Open PRs in `review`, `queued`, checks running, or threads you answered last | badge · #N title · "needs review 2d" / "CI 3/7" · project | Open PR (badge) / snooze | `openPrRows` split by §2.1 (R); age (S) |
| 4 | **Up next** | Unlinked assigned issues, ranked ready-for-agent → Linear priority → sidebar order | source icon · id · title · priority/label · project | Start work (new workspace + agent) | existing (R) + priority (R) |
| 5 | **Tidy up** (collapsed by default) | Workspaces with a merged/closed PR, "diff but no PR", orphaned sessions | workspace · reason | Remove workspace / open diff | (R); dirty-safe check (S) |
| 6 | **Footer pulse** | "5 running · 7 open PRs · 3 merged this week · median unblock 1m" | text | → Stats view | stats store (R) |

Where each row lands depends on the §2.1 split:
- A blocked PR goes in §1 **or** §3, never both. ⚠ This **conflicts with
  ADR-197 §3**, where blocked/ready PRs deliberately appear twice (Needs you
  plus Open PRs as an inventory). "Whose move" gives each PR exactly one home,
  which cuts the length and the double-counting.
- The ADR-197 Open PRs "inventory" can live on the Projects overview card or in
  a PR palette view.
- PRs still in `pending` with no running checks (for example drafts) belong in
  §3 under a "Drafts" sub-label, or under the workspace in §2 if an agent is
  on it.

### 4.2 Scale rules

| Situation | Rule |
|---|---|
| 1 project | Drop project chips; they repeat. Show sections uncapped up to their normal limits. |
| 10 projects | Keep chips, coloured with `projectColorStyle` (already used on Home). Up next goes to **top 1 per project, then fill to 5 globally**, with "View all (N)" opening the `up-next` palette view (ADR-197 §2). This replaces 3 per project (⚠ ADR-197 §1) to respect P2. |
| 3 PRs | Show them all. |
| 40 PRs | §1 shows every "your move" PR; it is a to-do list and should not be capped silently, so use "N more" after 6. §3 groups by project, one collapsed line per project ("manor · 8 waiting · oldest 4d"), and expands on click. |
| 20 running agents | §2 collapses to per-project counts ("manor 6 · api 3") after 6 rows. The count is the glanceable part (P3). |
| Page budget | Sections 0–2 should fit above the fold on a 900px-tall window. Cap: §1 6 rows, §2 6, §3 5, §4 5, §5 collapsed. |

### 4.3 Empty states

| Section | Empty state |
|---|---|
| Whole page (nothing pending, nothing running) | One calm line, "All clear. Nothing needs you", plus the Up next section (the supply of new work) and the ⌘N launcher. That is ADR-194's behaviour with one change: Up next still shows. |
| Your move | Hidden when empty, as in ADR-194. |
| Agents at work | "No agents running · ⌘N to start one" |
| Up next, source not connected | "Connect Linear to see assigned issues" (link to settings) or "gh not signed in". It must not stay silently empty (P7/P8). |
| Up next, connected but empty | "No unassigned-to-a-workspace issues assigned to you." plus "Browse all issues" |
| Waiting on others / Tidy up | Hidden when empty |

### 4.4 Three layout directions (for mockups)

**A. "Queue": a single column (evolves the current Home).** Keeps the 480px
`EmptyStateShell` column (ADR-194) and stacks sections 0→6. It is the smallest
change, reads well in a narrow pane, and has the strongest "do the top thing"
feel. Its weakness is width: agents and PRs can't be seen side by side, so
Few's single-screen goal (P2) fails early at scale.

**B. "Lanes": three columns by whose move it is.** Columns are **You** (§1),
**Agents** (§2), and **Others & CI** (§3). Up next sits as a strip underneath,
and the status strip goes on top. This is closest to a monitoring dashboard:
each lane has a header count and all three are visible at once. Lanes collapse
to A below about 900px. It suits users running many agents.

**C. "Projects grid with attention rail."** A left rail holds §1 as a compact
queue. The main area is a card per project (reusing `ProjectCard`, extended
with running agents, PR chips, diff totals and a dev-server chip), sorted with
projects that need you first. This merges Home with the Projects overview
(ADR-194 §2) and suits the 10-project case. It is weaker for a single-project
user, where it degenerates into one card.

---

## 5. Open questions for the user

1. **Placement.** Home's dashboard renders only when Home has no tabs
   (`src/App.tsx:748-759`). Opening the Home agent hides it. For a "full-blown"
   dashboard, should it be a permanent surface (like the Projects overview's
   `activeSurface`, ADR-194 §2), a pinned Home tab, or merged into the Projects
   overview (direction C)?
2. **Whose move vs inventory.** Is it acceptable to drop ADR-197's deliberate
   duplication, so that each PR appears once, in *Your move* or *Waiting on
   others*?
3. **Merge from Home?** ADR-194 excluded it. "Ready to merge" is one of the
   highest-actionability rows. Should Home offer quick-merge when
   `can-quick-merge` holds?
4. **Up next density.** Keep 3 per project (ADR-197), or switch to 1 per project
   plus a global fill to 5?
5. **Snooze.** Should "waiting on others" PRs and finished agents be
   snoozable/dismissable, and should that persist (main) or not?
6. **Worth an S-sized main change?** Candidates:
   - `statusSince` / `lastHookAt` / subagent count on `agent-status`
   - keeping PR `updatedAt`
   - fetching the *last* thread comment

   Each unlocks a row detail above.
7. **Review requests (N).** Is the GraphQL search poller in main (R1 §3.1) now
   in scope? Without it, "Waiting on others" only covers the user's own PRs
   that have workspaces.
8. **Stats on Home.** Is a one-line footer pulse wanted, or should
   reflection metrics stay only in the palette's Stats view?
