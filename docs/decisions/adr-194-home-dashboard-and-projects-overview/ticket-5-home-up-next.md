---
title: Home Up next section from assigned issues
status: in-progress
priority: medium
assignee: opus
blocked_by: [4]
---

# Home Up next section from assigned issues

ADR-194 §1 "Up next". It adds the section to `HomeDashboard`, between Needs
you and the summary line.

## Fetching
- New hook `src/components/sidebar/HomeDashboard/useUpNextIssues.ts`:
  - run `github.checkStatus()` once (cache it with React Query,
    `staleTime: Infinity`). Skip GitHub if gh is not installed or not
    authenticated.
  - for each `buildTopLevelEntries(projects)` entry, pick one member (group →
    `lastUsedHostId` member, else first). Then:
    - GitHub: `github.getMyIssues(ghRepoOf(member), 10, "open")`
    - Linear, if `linearAssociations` is non-empty and `linear.isConnected()`:
      `linear.getMyIssues(teamIds, { stateTypes: ["unstarted", "backlog"],
      limit: 10 })`. Check the actual accepted `stateTypes` values in the
      Linear views first.
  - `useQueries`, with keys like `["home-up-next", "gh", hostId, path]`,
    `staleTime: 60_000`, and `refetchInterval: 60_000` while mounted. Errors are
    swallowed per source (log once).
  - map the results to `UpNextIssue` and pass them through `isIssueLinked` and
    `rankUpNext` (ticket 1). Return `{ top: UpNextIssue[] /* first 3 */, total }`.

## Starting work
- Extract the start-work logic from
  `src/components/command-palette/GitHubIssueDetailView.tsx`
  (`handleCreateWorkspace`, ~69-112) into a shared helper, e.g.
  `src/lib/start-issue-work.ts`. It builds the branch name, reuses an existing
  workspace on that branch (select + `linkIssueToWorkspace`), or calls
  `onNewWorkspace({ projectId, name, branch, agentPrompt, linkedIssue })`, then
  runs `assignIssueBestEffort`. Keep the palette calling the helper, with no
  behavior change. Do the same for the Linear detail view if it has an
  equivalent (find it). The linked-issue id format stays as the palette writes
  it (`gh-N`).
  - `getMyIssues` doesn't return the body. Fetch
    `github.getIssueDetail(repo, n, url)` on click for the agent prompt, as the
    palette does, or use the title only if the detail fetch fails.
- `HomeDashboard` needs `onNewWorkspace`. Thread App's `handleNewWorkspace`
  through `HomeEmptyState` → `HomeDashboard`.

## UI
- Section header "Up next" (same `.sectionHeader`), with a right-aligned dim
  "All issues" text button. It opens the palette via
  `onOpenPaletteView("github-all")`, or `"linear-all"` when the selected
  project is Linear-linked. Thread `onOpenPaletteView` through.
- Rows: a CircleDot icon in accent color, then `#N title` (Linear:
  `identifier title`), and the project name on the right. Hover hint: "Start
  agent ↵". Click → the start-work helper.
- Summary line: append "N issues ready" (from `total`).
- "Nothing needs you" shows only when Needs you **and** Up next are both empty.

## Files to touch
- `src/components/sidebar/HomeDashboard/useUpNextIssues.ts` — new
- `src/components/sidebar/HomeDashboard/HomeDashboard.tsx`
- `src/components/sidebar/HomeEmptyState.tsx`
- `src/lib/start-issue-work.ts` — new
- `src/components/command-palette/GitHubIssueDetailView.tsx` — use the helper
- the Linear issue detail view — use the helper, if applicable
- `src/App.tsx` — pass `handleNewWorkspace` to HomeEmptyState
