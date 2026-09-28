# Research: a deterministic Home dashboard

**Question.** Manor's Home view is barely used. Could it become a dashboard across
**all** projects that answers three questions: *what should I work on next*, *which
PRs are open*, and *what needs fixing*? The first version must be deterministic.
It can make no LLM calls, and it can only use data Manor already has or can fetch
from git, `gh` or the GitHub API, local state and agent status.

**Method.** I read the code under `electron/` and `src/`, the ADRs in
`docs/decisions/`, and the output of `manor --help`. I also ran some read-only
`gh` and `git` commands to check field availability and query cost. Unless
another location is given, paths are relative to the repo root. External facts
link to the official GitHub, gh CLI or git docs.

`docs/research/` already existed (ADR-192 cites
`docs/research/mixed-local-remote-workspaces.md`) but was empty, so this note is
saved there.

---

## TL;DR

- **Home today is a pinned pseudo-workspace with an empty state.** It is a
  sentinel path `__home__` whose cwd is `~/.manor/home`. When it has no tabs it
  shows six launcher buttons. It holds no project data of its own.
- **Most of the data a dashboard needs is already in the renderer, across all
  projects.** It is kept up to date by three watchers in `Sidebar.tsx`:
  - branch per workspace (push, 2s local / 5s remote)
  - diff stats against the default branch (push, 5s)
  - PR state per workspace branch (renderer poll, 60s): checks, review decision,
    conflicts, unresolved threads, merge queue and draft
  - live agent status per pane (push), with an unseen flag
  - notifications (push)
  - listening ports (push, 3s)

  A dashboard can start as **pure selectors over existing stores**.
- **Missing pieces:**
  - dirty/ahead/behind git state
  - timestamps for "waiting since"
  - any recency or last-activity data per workspace
  - PRs that have no local workspace, such as review requests
  - label-filtered issue queries, e.g. `ready-for-agent`
  - an "activity" timestamp on workspaces
- **GitHub auth is the user's `gh` login.** Manor stores no token. One GraphQL
  `search` call returns every open PR by me or requesting my review, across
  repos, with checks, review decision and mergeability. I measured its cost at
  **1 point** out of 5,000 per hour. Today Manor spends one `gh pr list` per
  workspace per minute.

---

## 1. The current Home

| Aspect | Fact | Source |
|---|---|---|
| Identity | Sentinel workspace path `HOME_PATH = "__home__"`, `isHomePath()` | `src/lib/home-path.ts:12-17` |
| Real cwd | `~/.manor/home` is created at startup. The sentinel is mapped to it at the pty boundary (`resolveSpawnCwd`). | `src/lib/home.ts:6-18`; commit `110adec9` (`electron/paths.ts`, `electron/app-lifecycle.ts`) |
| Origin | Started as the "Orchestrator" surface of ADR-153 and was later renamed to Home: a pinned global agent that "sees & steers every session" | `docs/decisions/adr-153-orchestrator-ux/index.md`; commit `110adec9` |
| How it is reached | A pinned **Home** row above the Projects list in the sidebar, which calls `setActiveWorkspace(HOME_PATH)` | `src/components/sidebar/Sidebar/Sidebar.tsx:362-379` |
| | App menu `home` handler | `src/lib/menu-handlers.ts:246` |
| | Navigation history surface `{kind:"surface", surface:"home"}` | `src/store/navigation-history-store.ts:17`, `src/store/app-store.ts:634-639`, `src/hooks/useNavigationHistory.ts:53` |
| | Restored on boot if it was the last active surface | `src/App.tsx:88-93` |
| What renders | Home is a normal `WorkspaceLayout` keyed by the sentinel, so tabs and panes work as in any workspace | `src/App.tsx:660-675` |
| | With no tabs it renders `<HomeEmptyState>` | `src/App.tsx:683-684` |
| | `HomeEmptyState` shows buttons for Add Project, New Agent (⌘N), Open Terminal (⌘T), New Browser Window (⌘⇧B), Command Palette (⌘K), and optionally an Issues shortcut. It is built on `EmptyStateShell`. | `src/components/sidebar/HomeEmptyState.tsx:21-61` |
| Agent launch | ⌘N boots the configured home harness (claude, codex or custom; Settings → Home) | `src/lib/home.ts:21-23`, `src/App.tsx:358-363`, `src/components/settings/HomeSettingsPage.tsx` |
| Theme | No project theme; uses the global theme | `src/App.tsx:333-338` |
| Host | Always the local host | `src/lib/hosts.ts:155` |
| What it can access | It is part of the same renderer as the sidebar, so every Zustand store is in reach: `useProjectStore`, `useAgentStore`, `useAppStore.paneAgentStatus`, notification store, host store. It needs no new IPC to read what the sidebar already shows. | see §2 |

**Key point.** The dashboard can replace `HomeEmptyState`, which shows only when
Home has no tabs. It could also become a pinned "Dashboard" tab type so it
coexists with the Home harness session. Either way, the Home agent keeps its
role from ADR-153.

---

## 2. Data Manor already has

Legend: **push** means main sends it on change. **poll** gives who polls and how
often. **on-demand** means it is fetched only when asked.

### 2.1 Projects, linked groups, hosts

- **Persisted state.** Projects live in `projects.json` under `manorDataDir()`
  (`electron/projects/state-store.ts:22-24`). The main types:
  - `PersistedProject`: id, name, path, `defaultBranch`, `hostId`,
    `workspaceIssues`, `workspaceHidden`, `workspaceFolders`, `color`,
    `agentCommand`, `linearAssociations`, and more
    (`electron/projects/types.ts:163-206`)
  - `PersistedHost` (`:214-227`)
  - `PersistedProjectGroup` (ADR-192/193): `memberIds`, `lastUsedHostId`,
    `originKey` and shared fields (`:235-259`)
- **Renderer copy.** `ProjectInfo` (`electron/projects/types.ts:66-106`;
  `src/store/project-store.ts:368-435`) adds `workspaces: WorkspaceInfo[]` and
  `group?: ProjectGroupInfo`. The renderer loads it from `projects:getAll`
  (`electron/ipc/projects.ts:32-34`) and reloads it on:
  - window focus (`src/App.tsx:385-389`)
  - `projects-changed` pushes (`src/App.tsx:378-380`)
- **Linked groups.** A group is one repo spread across several single-host
  projects, so the dashboard should **dedupe PRs and issues by repo**
  (`originKey`), not by project.
  - Invariant: at most one member per host (`electron/projects/types.ts:230-234`;
    ADR-192 §1).
  - Helpers: `src/lib/project-groups.ts:12,28`.
- **Hosts.** The host store loads from `hosts:list` and gets push updates on
  `hosts:statusChanged` (`src/store/host-store.ts:49-76`;
  `electron/ipc/hosts.ts:33,51`).
  - Offline test: `isHostOffline` / `groupHostState` (`src/lib/host-status.ts:152,174`).
  - While a remote host is away, its projects show the last-known workspace list,
    held in memory (`electron/projects/project-info.ts:92-119`).

### 2.2 Workspaces / worktrees

- **Listing.** `git worktree list --porcelain` with a 5s timeout produces
  `{path, branch, isMain}` (`electron/backend/exec-git.ts:244-291`). It is merged
  with persisted metadata (name, `linkedIssues`, `hidden`, `folderId`) into
  `WorkspaceInfo` (`electron/projects/project-info.ts:184-209`; `types.ts:38-46`).
- **Refresh.** Listing runs on demand; change detection is push:
  - local: `WorktreeWatcher` uses `fs.watch` on `.git/worktrees`
    (`electron/projects/worktree-watcher.ts:94-136`)
  - remote: `RemoteWorktreePoller` runs every 10s (`:139-208`)
  - both send `projects-changed`
- **Linked issues.** `project.workspaceIssues[path]`
  (`electron/projects/workspace-folders.ts:309-340`). These give the mapping
  "this workspace is working on issue #N".
- **Not available.** No workspace carries a created, last-opened or activity
  timestamp (`electron/projects/types.ts:38-105`).
  - Layout persistence stores only `lastActiveWorkspacePath`
    (`electron/terminal-host/layout-persistence.ts:117-127`).
  - Navigation history is in memory only and has no timestamps
    (`src/store/navigation-history-store.ts:16-18,62-72`).

### 2.3 Git state

| Data | How | Cadence | Channel | Source |
|---|---|---|---|---|
| Current branch | Local: read `.git/HEAD`. Remote: `git rev-parse --abbrev-ref HEAD` | poll in main (2s local / 5s remote), sent as a push | `branches:start/stop`, push `branches-changed` | `electron/branch-watcher.ts:13-131`; `electron/ipc/branches-diffs.ts:24-31,77` |
| Diff vs default branch (+/−) | `git merge-base origin/<default> HEAD`, then `git diff <base> --shortstat` | poll in main every 5s, sent as a push | `diffs:start/stop`, push `diffs-changed` | `electron/diff-watcher.ts:22-150` |
| Dirty (uncommitted) | `git status --porcelain`, **only** inside the quick-merge check | on demand | `projects:canQuickMerge` | `electron/projects/worktrees.ts:367-424` |
| Ahead/behind upstream | **Not computed anywhere.** A grep for `rev-list` and `left-right` in `electron/` and `src/` returns nothing. | — | — | — |
| Can fast-forward merge | `git merge-base --is-ancestor <default> <branch>` | on demand | `projects:canQuickMerge` | `electron/projects/worktrees.ts:367-424` |
| Default branch | `symbolic-ref refs/remotes/origin/HEAD` | on the first `getProjects` | — | `electron/projects/branches.ts:14-88` |

- **Where it lands.** Renderer consumers are `useBranchWatcher` and
  `useDiffWatcher`, mounted in `Sidebar.tsx:95-97`. They watch **every
  workspace of every project**. Results go to `WorkspaceInfo.diffStats` via
  `updateWorkspaceDiffStats` (`src/store/project-store.ts:1568-1601`).
- **Remote hosts.** Git runs through `WorkspaceBackend.git` on each host, over
  ssh for remotes (`electron/backend/types.ts:83-145,266-277`;
  `electron/backend/remote-exec.ts`). So the same data exists for remote
  workspaces while the host is connected.
- **Caveats.**
  - `branches-changed` and `diffs-changed` are keyed by bare path.
    Identical paths on two hosts can collide in the renderer
    (`src/store/project-store.ts:1571,1585`); ADR-191 covers the identity model.
  - Issue #269 reports that git routes can resolve the wrong host.

### 2.4 Pull requests (per workspace branch)

- **Fetch.** `GitHubManager.getPrForBranch` runs
  `gh pr list --head <branch> --state all --json number,state,title,url,isDraft,additions,deletions,reviewDecision,statusCheckRollup,updatedAt,autoMergeRequest,mergeable --limit 1`
  (`electron/github.ts:180-198`).
- **Conversation data.** A second GraphQL call fetches unresolved review
  threads, comment and review counts, recent comments and `isInMergeQueue`
  (`electron/github.ts:302-319`). It is cached per PR URL until `updatedAt`
  changes or 5 minutes pass (`electron/github.ts:41-49,266-294`).
- **Shape.** `PrInfo` fields: `state`, `isDraft`, `reviewDecision`, `checks`
  (passing/failing/pending counts), `checkRuns`, `unresolvedThreads`,
  `commentCount`, `latestComment`, `queuedToMerge`, `hasConflicts`
  (`src/lib/pr-info.ts:6-106`). The check-status mapping is at
  `electron/github.ts:618-689`.
- **Polling.** `usePrWatcher` in the renderer runs every **60s**
  (`src/hooks/usePrWatcher.ts:8-14`). It also runs on window focus, on a branch
  fingerprint change, and on PR popover hover. It covers only **non-main
  workspaces with a branch**, processed one project at a time (`:27-58`).
- **Channel and store.** IPC `github:getPrsForBranches`
  (`electron/ipc/integrations.ts:11-18`). Results are stored as
  `WorkspaceInfo.pr` (`src/store/project-store.ts:1603-1614`).
- **Readiness rule.** `prReadiness()` already ranks each PR deterministically
  (`src/lib/pr-readiness.ts:17-72`, ADR-167). The order is:
  1. merged
  2. closed
  3. **blocked**: conflicts, failing checks, `CHANGES_REQUESTED`, or unresolved
     threads
  4. queued
  5. review (`REVIEW_REQUIRED`)
  6. ready (approved and checks clear)
  7. pending

  **This is the "what needs fixing" rule for PRs, already written.**
- **Change events.** `diffPrEvents` emits comment, approved, changes-requested
  and checks-failed events, which feed notifications
  (`src/utils/pr-notifications.ts:24-75`; ADR-147).
- **Gap.** A PR is only visible if a local workspace is on its branch. Review
  requests, PRs opened from another machine, and PRs from `main` checkouts are
  invisible.

### 2.5 Issues

- **GitHub.**
  - `gh issue list [--assignee @me] --json number,title,url,state,labels,assignees`
    (`electron/github.ts:339-388`)
  - `gh issue view` (`:395-414`), assign (`:417-428`), create (`:446-493`)
  - IPC `github:getMyIssues`, `github:getAllIssues` and more
    (`electron/ipc/integrations.ts:22-74`)
  - Renderer: palette view with react-query key `github-issues`
    (`src/components/command-palette/GitHubIssuesView.tsx:53-68`)
  - **No label filtering exists.** Labels are fetched but only displayed.
- **Linear.** Raw GraphQL with an API key encrypted by `safeStorage` in
  `linear-token.enc` (`electron/linear.ts:60-85,382-416`).
  - `getMyIssues` returns assigned `unstarted` issues sorted by state and
    priority (`:101-160`).
  - Projects map to teams via `project.linearAssociations`.
- **Control API and CLI.**
  - Route: `GET /projects/:id/issues?source=&filter=all|assigned&state=&limit=`
    (`electron/routes/issues.ts`)
  - CLI: `manor list-issues` (flags `--filter assigned|all`, `--state`,
    `--limit`, `--source`; no label flag)
- **Start work on an issue.**
  - From the palette: creates branch `${number}-${slug}`, links `gh-${n}`, and
    makes a best-effort self-assign
    (`src/components/command-palette/GitHubIssueDetailView.tsx:69-112`).
  - Batch: `manor batch-create-workspaces --issues N [--start-agent]
    [--prompt-template]` posts to `POST /projects/:id/workspaces/batch`
    (`electron/routes/projects.ts:387-583`).
    **These are the click-through actions for an "issues ready for agents"
    widget.**
- **Bugs found on the way:**
  - The agent primers tell agents to use `--issues 1,2,3`
    (`electron/scripts/agent-hook.js:161,173`;
    `src/lib/orchestrator-primer.ts:37`). The CLI parser calls `Number()` on
    each flag value, so `"1,2,3"` fails (`electron/mcp/cli.ts:170-176,294-299`).
    Only repeated flags work.
  - Batch creation links issue id `"42"` while the palette links `"gh-42"`, so
    "does this issue already have a workspace?" must match both forms.

### 2.6 Agents

- **Persisted record.** `agents.json`, a list of `AgentInfo`
  (`electron/agent-persistence.ts:35-66`). Fields:
  - `id`, `agentSessionId`, `name`
  - lifecycle `status`: `active|completed|error|abandoned`
  - `createdAt`, `updatedAt`, `completedAt`, `activatedAt`, `resumedAt`
  - `projectId`, `hostId`, `workspacePath`, `paneId`, `agentKind`
  - `lastAgentStatus`

  Records are pruned after `agentRetentionDays`, default 90 (`:352-367`).
- **Live status.** Decided only by the Status reconciler in main
  (`electron/agent-status/reconciler.ts`; `CONTEXT.md`; ADR-184). Values:
  `idle|thinking|working|requires_input|error|responded`
  (`src/electron.d.ts:246-260`).
- **Push channels.**
  - `agent-updated` sends `(AgentInfo, unseen flags)` to the main window
    (`electron/notifications.ts:146-167`).
  - `agent-status` sends `{paneId, status, reason, kind}` to all windows
    (`electron/app-lifecycle.ts:577-580`).
- **Renderer stores.**
  - `useAgentStore.agents` covers all projects: active agents plus the first 100
    of all (`src/store/agent-store.ts:86-114`). It also holds
    `unseenRespondedAgentIds` / `unseenInputAgentIds` (`:25-27`).
  - `useAppStore.paneAgentStatus` holds status per pane
    (`src/store/app-store.ts:249,2407-2419,3580-3595`).
- **Existing aggregation.** `workspace-indicator.ts` maps statuses to
  `thinking` / `working` / `needs_you` (requires_input or error) /
  `done_unread` (`src/lib/workspace-indicator.ts`). It rolls up per workspace,
  project and group with `pickBestPaneStatus` (`src/hooks/useTabAgentStatus.ts:7-74`;
  `useProjectAgentStatus.ts:37-121`).
- **No "status since" timestamp.**
  - `updatedAt` changes on any update, not just status changes
    (`electron/agent-persistence.ts:241-256`).
  - `PaneAgentStatusUpdate` has no time field (`src/electron.d.ts:266-278`).
  - The waiting time tracked in `StatsStore.blockedAt` stays in memory and is
    only exposed as totals (`electron/stats-signals.ts:128-134,176-205`).
- **Risk: `requires_input` may not last.** Rule T2 of the reconciler (the
  stuck-working safety net) forces any *active* status to `responded` after
  `STALE_ACTIVE_MS = 60_000` with no hook. `ACTIVE_STATUSES` includes
  `requires_input`, and T2 makes no exception for it
  (`electron/agent-status/reconciler.ts:103,111-115,944-965`). I found this by
  reading the code and did not test it.

  If it holds, a pane waiting on a permission prompt may show `responded`
  after about 60s. That would break any "waiting for input > 5 min" rule until
  it is fixed or confirmed intended.

### 2.7 Notifications, stats, ports

- **Notifications (ADR-162).**
  - Stored in main in `notifications.json`, capped at 200 records and 30 days
    (`electron/notification-store.ts:17-54,120-129`).
  - Kinds: `agent-responded`, `agent-requires-input`, `pr-comment`,
    `pr-approved`, `pr-changes-requested`, `pr-checks-failed`, `badge-unlocked`.
  - Each record has a `timestamp`, `read` and a `target` (agent, url or stats).
  - The full list is pushed on `notifications:changed`
    (`electron/notifications.ts:69-86`). Renderer store:
    `src/store/notification-store.ts`.
  - The `agent-requires-input` timestamp is the best "waiting since" proxy
    available today. It is only written when `notifyOnRequiresInput` is on
    (`electron/notifications.ts:253-285`).
- **Stats (ADR-168).** `stats.json` holds global counters by day: prompts, tool
  calls, unblock times, PRs merged. Nothing is per project
  (`electron/stats-store.ts:28-112`). The push is `stats:changed`.
- **Ports.**
  - `PortScanner` polls every 3s per host and pushes `ports-changed`
    (`electron/ports.ts:12-39`).
  - Each entry is `{port, processName, pid, workspacePath, hostname}`
    (`electron/backend/types.ts:173-189`).
  - The renderer holds ports only in local state inside `usePortsData`
    (`src/components/ports/usePortsData.ts:15-138`), mounted by `PortsList`. A
    dashboard would need to lift this into a store or subscribe to it a second
    time.
- **Processes / orphaned sessions.** `listProcesses` returns sessions alive in
  the daemon but absent from the layout (`electron/process-control.ts:64-113`;
  ADR-117). It is fetched on demand (`manor list-processes`).

### 2.8 CLI surface (`manor --help`)

These commands already cover the data a dashboard would show, and a Home agent
can use them too:

- `list-projects`, `list-workspaces`
- `list-agents` ("every agent session … across every project"), `read-session`
- `list-issues`, `batch-create-workspaces`
- `can-quick-merge`, `quick-merge-workspace`
- `list-notifications`, `scan-ports`, `list-processes`, `github-status`
- `manor api <GET|POST|DELETE> <path>` for raw control-server routes

---

## 3. Data that is cheap to add deterministically

### 3.1 GitHub

**Auth and limits today**

- Manor runs `gh` through `execFile` using the user's login. It reads no token
  itself (`electron/github.ts:19,82,97-109`).
- Status comes from `gh auth status` (`:549-579`). Readiness is memoized for the
  whole process (`:132-138`), so authenticating mid-session needs a restart.
- There is no rate-limit handling beyond the 60s poll and the conversation cache
  (`src/hooks/usePrWatcher.ts:8-14`; `electron/github.ts:116-123`).

**Documented limits**

- REST: 5,000 requests per hour for an authenticated user
  ([REST rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)).
- Search: 30 requests per minute
  ([REST search rate limit](https://docs.github.com/en/rest/search/search#rate-limit)).
- GraphQL: 5,000 points per hour, where a query's cost depends on how many
  nodes it requests
  ([GraphQL rate limits](https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api)).
- `gh api rate_limit` on this machine returned `core 5000`, `graphql 5000` and
  `search 30`.

**Queries a dashboard would need**

| Need | Query | Notes |
|---|---|---|
| **My open PRs across all repos**, with CI, review and mergeability | GraphQL `search(query:"is:pr is:open author:@me archived:false", type:ISSUE, first:50)` selecting `... on PullRequest { number title url repository{nameWithOwner} isDraft reviewDecision mergeable mergeStateStatus updatedAt headRefName commits(last:1){nodes{commit{statusCheckRollup{state}}}} }` | Tested here: returned 10 PRs at `rateLimit.cost = 1`. Field docs: [PullRequest](https://docs.github.com/en/graphql/reference/objects#pullrequest), [StatusCheckRollup](https://docs.github.com/en/graphql/reference/objects#statuscheckrollup), [MergeStateStatus](https://docs.github.com/en/graphql/reference/enums#mergestatestatus). One call could replace N per-branch `gh pr list` calls. |
| **Review requested of me** | same query with `review-requested:@me` | Qualifiers: [Searching issues and PRs](https://docs.github.com/en/search-github/searching-on-github/searching-issues-and-pull-requests). CLI version: `gh search prs --review-requested=@me --state=open` ([gh search prs](https://cli.github.com/manual/gh_search_prs)). Note: the `gh search prs --json` fields do **not** include `statusCheckRollup` or `reviewDecision` (checked with `gh search prs --json`), so use GraphQL. |
| **Failing CI only** | `--checks failure` or the `status:failure` qualifier | [gh search prs](https://cli.github.com/manual/gh_search_prs), `--checks {pending,success,failure}` |
| **Stale PRs** | `updated:<YYYY-MM-DD` qualifier, or sort client-side by `updatedAt` | the search-syntax doc above |
| **Issues by triage label** | `gh issue list --label ready-for-agent --json number,title,url,labels,assignees,updatedAt`, or a search for `is:issue is:open label:ready-for-agent repo:X` | [gh issue list](https://cli.github.com/manual/gh_issue_list) `--label` / `--search` |
| **Digest** | `gh status` lists assigned issues and PRs, review requests, mentions and repo activity | [gh status](https://cli.github.com/manual/gh_status). Output is text only, so GraphQL is better for a UI. |

**Batching.** A GraphQL search can span repos, but it runs as one query per
repo-scope string. For N project repos, add `repo:a/b repo:c/d` qualifiers to
one query. Group members that share an origin collapse to one repo (§2.1).

**Triage labels.** `docs/agents/triage-labels.md` defines five roles:
`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`.
On `orrybaram/manor`, only `ready-for-agent` and `wontfix` exist as labels today
(`gh label list`). Label names should be configurable per project. Assuming
this vocabulary exists in every repo would be wrong.

### 3.2 Local git (per workspace, runnable on any host through `WorkspaceBackend.git`)

| Need | Command | Doc |
|---|---|---|
| Dirty, ahead and behind in **one** call | `git status --porcelain=v2 --branch`, which prints `# branch.ab +N -M` plus entry lines | [git-status: porcelain v2](https://git-scm.com/docs/git-status#_porcelain_format_version_2) |
| Ahead/behind against the default branch | `git rev-list --left-right --count origin/<default>...HEAD` | [git-rev-list `--left-right`, `--count`](https://git-scm.com/docs/git-rev-list) |
| Every branch's upstream, gone state and age in one call | `git for-each-ref --format='%(refname:short)|%(upstream:short)|%(upstream:track)|%(committerdate:iso-strict)' refs/heads` | [git-for-each-ref `upstream:track`](https://git-scm.com/docs/git-for-each-ref). Tested here: prints `[gone]` for a branch whose remote was deleted. |
| Merged branches safe to delete | `git branch --merged origin/<default>` | [git-branch `--merged`](https://git-scm.com/docs/git-branch). This misses **squash-merged** branches, which is why `[gone]` upstream plus `pr.state == "merged"` (already in `PrInfo`) is the stronger signal. |
| Prunable / missing worktrees | `git worktree list --porcelain`, which flags `prunable` | [git-worktree](https://git-scm.com/docs/git-worktree). Manor already runs this. |
| Last commit time (activity proxy) | `git log -1 --format=%cI` | [git-log](https://git-scm.com/docs/git-log) |

**Suggested approach.** Extend the 5s `DiffWatcher`, or add a sibling
`PerHostPoller` at about 15–30s, to return
`{dirtyCount, ahead, behind, upstreamGone, lastCommitAt}` per workspace. It
would reuse `PerHostPoller`'s per-host serialization and emit-on-change
(`electron/per-host-poller.ts:56-263`).

**Local state worth recording.** A persisted `lastFocusedAt` per workspace key
(written by `setActiveWorkspace`), and a `statusSince` on `PaneAgentState` that
is published with `agent-status`. Both are small main-side changes. They unlock
"recently active" and "waiting > N min".

---

## 4. Candidate widgets

Ranking rules are deterministic and cheap to unit-test as pure functions, in the
same style as `prReadiness` and `diffPrEvents`. Cost key: **R** reuses existing
plumbing (selectors only), **S** needs a small addition, **N** needs a new
fetch or poller.

### 4.1 "Needs you now" (attention queue): top of page

- **Shows.** Every agent pane across projects that needs the user, plus PRs of
  mine that need the user.
- **Sources.**
  - `paneAgentStatus` together with unseen sets (`useAgentStore`)
  - `workspace-indicator` states `needs_you` and `done_unread`
  - `WorkspaceInfo.pr` passed through `prReadiness`
- **Rule, in priority order:**
  1. agent `requires_input`
  2. agent `error`
  3. PR `blocked` because of conflicts or failing checks
  4. PR `CHANGES_REQUESTED` or `unresolvedThreads > 0`
  5. agent `responded` and unseen

  Within each tier, sort oldest first by the matching notification `timestamp`
  (best available proxy), later by `statusSince`.
- **Cost.** R for v1, S for real "waiting since" (a `statusSince` field). Check
  the T2 `requires_input` issue in §2.6 first.
- **Actions.**
  - Focus the pane (`focus-pane` / `setActiveWorkspace`), or `mark-agent-seen`.
  - Open the PR through `<Link>` (per `.claude/rules/ui-components.md`).

### 4.2 Running agents: at a glance

- **Shows.** Count and list of agents that are `thinking` or `working`, by
  project.
- **Source.** `useAgentStore.agents` (lifecycle `active`) joined with
  `paneAgentStatus`.
- **Rule.** Group by project. Show nothing for idle agents.
- **Cost.** R.
- **Action.** Jump to the pane.

### 4.3 My open PRs (all projects)

- **Shows.** One row per open PR with a readiness badge: draft, CI state, review
  decision, conflicts, unresolved threads, queued.
- **Sources.**
  - v1 (R): `projects.flatMap(ws.pr)` filtered to `state == "open"`, badges from
    `prReadiness`. This covers only PRs that have a workspace.
  - v2 (N): one GraphQL `search author:@me is:open` (§3.1), polled every
    60–120s in **main**. That catches PRs without workspaces and could replace
    the per-branch polling.
- **Rule.** Sort by readiness tier: blocked, then ready to merge, then review,
  then pending, then draft. Within a tier, oldest `updatedAt` first.
- **Actions.**
  - Open the workspace, or create one from the PR's `headRefName` (ADR-065,
    workspace from remote branch).
  - Open the PR in the browser.
  - `quick-merge-workspace` when `ready` and `can-quick-merge` both hold.

### 4.4 Review requests

- **Shows.** PRs where my review is requested, in any repo Manor knows about or
  all repos.
- **Source.** GraphQL `search review-requested:@me is:open`, the same poller as
  4.3 v2.
- **Rule.** Oldest request first. Flag "waiting > 24h".
- **Cost.** N (shares 4.3's poller).
- **Action.** Open in the browser, or check the branch out into a workspace and
  open the diff pane.

### 4.5 Up next: issues ready to work on

- **Shows.** Per project (deduped per group), open issues that are assigned to
  me, and/or labelled `ready-for-agent`, and have **no linked workspace yet**.
  Linear: `getMyIssues` for unstarted issues.
- **Sources.**
  - `gh issue list --label <cfg> --assignee @me`
  - Linear `getMyIssues`
  - minus issues present in any `workspaceIssues` (match both `gh-N` and `N`
    ids)
- **Rule.**
  1. `ready-for-agent` before assigned-to-me
  2. then Linear priority / GitHub milestone
  3. then oldest first
- **Cost.** S. Existing IPC plus a new `--label` parameter on
  `getMyIssues`/`getAllIssues` and the route. Configurable label names are new.
- **Actions.**
  - "Start agent": `batch-create-workspaces --issues N`, or the palette's Start
    Work flow.
  - Multi-select to fan out, with ADR-176's "≤4 at once" guidance.

### 4.6 Clean-up: safe to remove

- **Shows.** Workspaces whose PR is `merged` or `closed`, whose upstream is
  `[gone]`, or whose branch is fully merged into the default branch. Also
  worktrees marked `prunable`, and orphaned sessions.
- **Sources.**
  - `WorkspaceInfo.pr.state` (R)
  - `for-each-ref upstream:track` and `branch --merged` (N, cheap)
  - `list-processes` for orphans (R, on demand)
- **Rule.** Flag only when there are **no uncommitted changes** (needs the dirty
  check in §3.2) and no running agent in the workspace.
- **Actions.** "Remove workspace" (`remove-workspace`, which has progress UI),
  and `cleanup-dead-processes`.

### 4.7 Unfinished local work

- **Shows.** Workspaces with uncommitted changes, unpushed commits, or commits
  but no PR.
- **Sources.** The new git poller (dirty / ahead / upstream), `diffStats`
  (already live), and `ws.pr == null`.
- **Rule, in order:**
  1. commits ahead with no upstream and no PR (the "push & open PR" candidate)
  2. dirty with no running agent
  3. behind the default branch by more than N commits (needs a rebase)
- **Cost.** S/N (the poller from §3.2).
- **Actions.** Open the diff pane (`open-diff`), `git-push` (ADR-121), and open
  a "create PR" URL.

### 4.8 Stale

- **Shows.** Open PRs with `updatedAt` older than N days, and workspaces with
  no commit or focus in N days.
- **Sources.** `PrInfo` needs `updatedAt` kept; it is fetched but not stored in
  `PrInfo` today (`electron/github.ts:180-198`; `src/lib/pr-info.ts`). Also
  `lastCommitAt` and `lastFocusedAt` (§3.2).
- **Rule.** Age threshold, configurable (default 7 days).
- **Cost.** S.
- **Actions.** Open, hide the workspace (`set-workspace-hidden`), or remove it.

### 4.9 Environment health (small strip)

- **Shows.**
  - `gh` installed/authenticated (`github:checkStatus`)
  - hosts offline (`host-store`)
  - Linear connected
  - dev servers listening per workspace (ports)
  - GitHub rate-limit remaining (optional, one `gh api rate_limit` call, which
    does not count against the limit per the REST rate-limit docs)
- **Cost.** R, except ports, which need lifting out of `usePortsData`.
- **Action.** Links to Settings → GitHub, reconnect host, and `kill-port`.

### 4.10 Recent notifications (compact feed)

- **Shows.** The unread entries of the notification store, which already have
  targets.
- **Cost.** R. It duplicates the bell popover, so it is low value unless it
  replaces the popover on Home.

**Suggested v1 (all R or small S):** 4.1, 4.2, 4.3 (v1), 4.5 using assigned
issues only, and 4.6 using PR state only. v2 adds the main-side GraphQL
search (4.3 v2, 4.4) and the git-state poller (4.6 and 4.7 in full, 4.8).

---

## 5. Related ADRs

| ADR | Relevance |
|---|---|
| **ADR-153** Orchestrator UX | Home began as this pinned global agent surface. The dashboard should coexist with the Home harness session, not remove it. It also added `list_tasks` (now `list-agents`) and `send_to_session`. |
| **ADR-192** Linked projects / **ADR-193** UI cleanup | Groups of single-host projects for one repo. Dedupe by `originKey`. Per-member (per-host) settings stay machine-specific. The dashboard's "project" rows should follow `buildTopLevelEntries` (`src/utils/sidebar-items.ts:875-906`). |
| **ADR-191** Host-qualified workspace identity | Use `workspaceKey(hostId, path)` for every dashboard row key, not bare paths. |
| **ADR-160 / 178 / 188** Remote hosts, always-on remote projects, host liveness | Remote data goes stale while the host is away. Show a stale state rather than dropping rows. |
| **ADR-007 / 009 / 147** PR popover, unresolved comments, PR update notifications | The existing `PrInfo` pipeline and event diffing. ADR-147 chose renderer-side polling. |
| **ADR-167** Sidebar indicator states | `needs_you` / `done_unread` / `prReadiness` tiers. Reuse them so the dashboard and sidebar agree. |
| **ADR-162** Notification center | Main-owned notification log with timestamps and targets. |
| **ADR-184** Agent status reconciler, **ADR-131** stuck-working safety net | The only writer of agent status. Any `statusSince` field must come from here. The T2 rule interacts with `requires_input` (§2.6). |
| **ADR-036 / 037 / 071 / 070 / 148** Issues and linked issues | Issue fetching and start-work flows. Linked-issue storage. |
| **ADR-176** Reliable agent fan-out, **ADR-170/171** manor CLI / control surface | `batch-create-workspaces` and the ≤4 fan-out guidance. Every dashboard action already has a CLI/route equivalent. |
| **ADR-077** Quick merge, **ADR-121** git push, **ADR-065** workspace from remote branch | The actions behind the clean-up, local-work and PR widgets. |
| **ADR-079** Inline gh install | The `gh`-missing state. The inline install flow uses Homebrew, so it is macOS only (`src/components/sidebar/GitHubNudge.tsx:172`). |
| **ADR-136** Renderer/main contract | Main owns state; the renderer caches it. That argues for putting any new GitHub search poller in main. |
| **ADR-168** Stats and badges | Global only. Not useful per project without schema changes. |

---

## 6. Open questions and risks

1. **Placement.** Should the dashboard replace `HomeEmptyState`, which hides as
   soon as the Home agent has a tab open, or be a pinned tab or pane type
   inside Home? The second keeps the ADR-153 orchestrator usable alongside it.
2. **Where polling lives.**
   - PR polling is in the renderer today (ADR-147).
   - A global GraphQL search is better placed in main (ADR-136), where multiple
     windows and instances can share it.
   - Two app instances already doubled API usage (`electron/github.ts:116-123`
     comment).
3. **`requires_input` → `responded` after 60s** (T2, §2.6). Confirm the
   behaviour before building the "waiting for input" tier.
4. **No timestamps** for status changes, workspace focus or workspace activity.
   Deciding what to persist, and where, needs a small ADR.
5. **Multi-account and GHES.**
   - `checkStatus` only checks `--hostname github.com`
     (`electron/github.ts:549-579`).
   - The PR-URL regex only matches github.com (`electron/github.ts:302`).
   - GHES repos would show as "no data".
6. **Triage-label vocabulary differs per repo**, and most canonical labels don't
   exist yet on `orrybaram/manor`. This needs per-project config or a
   graceful "label not found".
7. **The REST search API is capped at 30/min.** I observed that the GraphQL
   `search` query left the REST `search` bucket at 30/30 (`gh api rate_limit`
   after the query) and cost 1 GraphQL point. GraphQL secondary limits still
   apply (see the GraphQL rate-limit docs). Keep it to about 1–2 queries per
   poll and back off on errors; today nothing detects rate limits
   (`electron/github.ts:282-285`).
8. **Squash merges** defeat `git branch --merged`. Clean-up must rely on PR
   `merged` state or `[gone]` upstream, and never delete a dirty worktree.
9. **Remote hosts.** Git state for a disconnected host is unavailable. Rows
   should show "host offline" and keep the last-known data. Issue #269 reports
   git routes resolving the wrong host.
10. **Existing bugs to fix before surfacing fan-out from the dashboard:**
    - `--issues 1,2,3` fails to parse (§2.5)
    - the `gh-N` vs `N` linked-issue id mismatch (§2.5)
11. **Scale.** `useAgentStore` loads only the 100 newest agents plus active ones
    (`src/store/agent-store.ts:86-114`). That is fine for "now" widgets but not
    for history.
