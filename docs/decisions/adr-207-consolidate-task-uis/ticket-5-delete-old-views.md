---
title: Delete palette issue lists, old detail views and dead plumbing
status: done
priority: medium
assignee: sonnet
blocked_by: [4]
---

# Delete palette issue lists, old detail views and dead plumbing

ADR-207 §4–§5 cleanup. After this, `pnpm test` (vitest + knip) must be clean.

## Delete
- `src/components/command-palette/LinearIssuesView.tsx`, `GitHubIssuesView.tsx`, `IssueListSkeleton.tsx`
- `src/components/command-palette/IssueDetailView.tsx`, `GitHubIssueDetailView.tsx`, `IssueDetailSkeleton.tsx`
- `CommandPalette.tsx`: `linearItems` / `githubItems` drill-ins and their categories, `navigateToLinearAll` / `navigateToGitHubAll`, `selectedIssueId`, `selectedGitHubIssueNumber`, `issueListOrigin`, `issueListEmpty`, `trackerProjectId`/`trackerProject`/`allTeamIds`/`repo` if now unused, `linearConnected`/`githubConnected` probes if unused, breadcrumb labels for the removed views, "Search tasks..." placeholder.
- `CommandPalette.module.css`: `.issueIdentifier`, `.issueState`, `.filterBar`…`.filterSelect`, `.skeletonRow`/`.skeletonIdentifier`/`.skeletonTitle`/`.skeletonState`, `.detail*` / `.skeletonDetail*` / `.skeletonSidebar*` / `.footerHint` / `.footerLinked` if no longer referenced (check `TaskDetail` took its own copy).
- `command-palette/utils.ts`: `PRIORITY_LABELS`, `extractImages`, `stripMarkdown` (moved in tickets 1–2).
- `types.ts`: `PaletteView` members `linear-all`, `github-all`, `issue-detail`, `github-issue-detail`; props `initialIssueId`, `initialGitHubIssueNumber`.
- `src/App.tsx`: `paletteInitialIssueId` / `paletteInitialGitHubIssueNumber` state and props.
- `src/lib/commands.ts:131` — `openPaletteView` union drops `"linear-all" | "github-all"`.

## Empty-state shortcut
- `src/components/sidebar/useIssuesShortcut.tsx`: drop the `onOpenPaletteView` parameter (gate on `probeKey` alone); action calls `showTasksView({ project: <selected project's entry key> })`.
- `src/components/sidebar/WorkspaceEmptyState.tsx` and `App.tsx`: drop `onOpenPaletteView` if now unused.

## Verify
`pnpm typecheck`, `pnpm test` (knip will flag orphans), `pnpm lint`.

## Files to touch
- files listed above
