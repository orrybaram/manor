---
title: Home launchers trim, Needs you section and summary line
status: todo
priority: high
assignee: sonnet
blocked_by: [1, 3]
---

# Home launchers trim, Needs you section and summary line

ADR-194 §1. It's blocked by 3 only because both touch
`EmptyState.module.css`.

## EmptyStateShell
- `src/components/sidebar/EmptyStateShell.tsx`:
  - add an optional `children` slot rendered under the actions `Stack`, inside
    the same 480px column, with `gap="3xl"` spacing like the logo/actions gap.
  - swap the raw `<button>` for `<Button variant="ghost" className={styles.action}>`.
    Make sure the ghost variant's own padding/hover doesn't fight
    `.action`; override in the module if needed. Keep the look pixel-identical.

## HomeEmptyState
- `src/components/sidebar/HomeEmptyState.tsx`:
  - actions become New Agent ⌘N, Open Terminal ⌘T, Command Palette ⌘K only.
    Remove Add Project, New Browser Window and the `useIssuesShortcut` action.
    Drop the now-unused props/imports; knip must stay clean. If
    `useIssuesShortcut` becomes unused everywhere, delete it.
  - children: `<HomeDashboard />`, new in
    `src/components/sidebar/HomeDashboard/`.
- **HomeDashboard** (this ticket renders Needs you and the summary line; ticket
  5 adds Up next):
  - It reads `useProjectStore.projects`, `useAppStore.paneAgentStatus` and
    `useAgentStore` (`agents`, `unseenRespondedAgentIds`), then calls
    `needsYouItems`, `runningAgentCount` and `openPrCount` from
    `src/lib/home-dashboard.ts` (ticket 1). Memoize on inputs.
  - **Section header:** a dim 12px label, then the count, then a hairline that
    fills the remaining width. Put it in `EmptyState.module.css` as
    `.sectionHeader` (ticket 3 may have added it already; reuse it).
  - **Rows:** same `.action` row as the launchers.
    - icon slot: Bot icon for agents, GitPullRequest for PRs, colored by tier
      (red input/error, peach blocked, green ready, teal finished; use the
      theme vars the sidebar indicators use)
    - label: "Agent wants input" / "Agent errored" / "Agent finished" +
      `· <workspace name>`, or `#N <reason>` / `#N ready to merge`
    - right side (where keycaps sit): project name (in the project color if
      set) and a dim age derived from `agent.updatedAt` ("4m", "3h", "2d").
      There's no age for PRs.
    - on hover, swap the age for the action text ("Focus ↵" / "Open ↵").
  - First 4 rows, then a dim "N more" row that expands in place.
  - Agent click → `navigateToAgent(agent)`. PR click → `selectProject` +
    `selectWorkspace` for that workspace.
  - **Summary line**, centered, dim 12.5px: "N agents running · N open PRs".
    Omit 0 segments, and render nothing if both are 0. Ticket 5 appends
    "N issues ready".
  - When there are no Needs-you items (and, after ticket 5, no Up next items),
    show one dim row with a green check: "Nothing needs you".
- Keep `data-testid="home-view"` on the shell. Update
  `tests/e2e/keyboard-navigation.spec.ts:~446` only if it asserts on removed
  launchers.

## Files to touch
- `src/components/sidebar/EmptyStateShell.tsx`
- `src/components/EmptyState.module.css`
- `src/components/sidebar/HomeEmptyState.tsx`
- `src/components/sidebar/HomeDashboard/HomeDashboard.tsx` — new
- `src/components/sidebar/HomeDashboard/HomeDashboard.module.css` — new (if needed)
- `src/components/sidebar/useIssuesShortcut.tsx` — delete if unused
- `src/App.tsx` — HomeEmptyState props, if they shrink
