---
title: Delete the dead Up next chain and rename tracker query keys
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Delete the dead Up next chain and rename tracker query keys

See ADR-202 §1. Pure deletion + key rename; no behaviour change.

1. Delete `src/components/command-palette/UpNextView.tsx`,
   `src/components/sidebar/HomeDashboard/useUpNextIssues.ts`,
   `src/components/sidebar/HomeDashboard/useStartUpNextIssue.ts`. Grep first to
   confirm nothing imports them.
2. In `src/lib/home-dashboard.ts` delete `normalizeIssueRef`, `isIssueLinked`,
   `UpNextIssue`, `priorityRank` (if only used by `rankUpNext`), `rankUpNext`,
   `upNextFromGitHub`, `upNextFromLinear`, `upNextList`,
   `topUpNextPerProject`, and the `// ── Open PRs ──` section (`OpenPrReadiness`,
   `OpenPrRow`, `OPEN_PR_RANK`, `openPrLabel`, `openPrRows`). Keep
   `primaryMember`, `blockedReason`, and every `prReadiness` import still used.
   Drop now-unused imports.
3. Delete the matching `describe` blocks in `src/lib/__tests__/home-dashboard.test.ts`.
4. `src/lib/home-dashboard-studio.ts` ≈102: reword the comment that names
   `openPrRows` so it doesn't reference a deleted function (comment only).
5. Rename the status query keys `["home-up-next", "gh-status"]` →
   `["trackers", "github", "status"]` and `["home-up-next", "linear-connected"]`
   → `["trackers", "linear", "status"]` in `useTasks.ts`, `TasksView.tsx`
   (invalidate on GitHub install) and `Sidebar.tsx`. Rename the list keys in
   `useTasks.ts` from `["tasks", provider, …]` to `["trackers", provider, "list", …]`.
   Update comments that say "same keys as Home's Up next".

Commit as `refactor(adr-202): delete dead Up next chain, rename tracker query keys`.

## Files to touch
- `src/components/command-palette/UpNextView.tsx` — delete
- `src/components/sidebar/HomeDashboard/useUpNextIssues.ts` — delete
- `src/components/sidebar/HomeDashboard/useStartUpNextIssue.ts` — delete
- `src/lib/home-dashboard.ts` — delete dead functions
- `src/lib/__tests__/home-dashboard.test.ts` — delete their tests
- `src/lib/home-dashboard-studio.ts` — comment only
- `src/components/tasks/useTasks.ts`, `src/components/tasks/TasksView.tsx`, `src/components/sidebar/Sidebar/Sidebar.tsx` — query keys
