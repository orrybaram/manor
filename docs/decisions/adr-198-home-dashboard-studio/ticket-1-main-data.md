---
title: Keep PR updatedAt and add a daily PRs-merged stats series
status: todo
priority: high
assignee: sonnet
blocked_by: []
---

# Keep PR updatedAt and add a daily PRs-merged stats series

Two small main-side data changes the dashboard needs.

## 1. `PrInfo.updatedAt`

`electron/github.ts` already requests `updatedAt` in the `gh pr view --json` field list (around line 209) and uses it as a cache key (around 286-293). It then drops it when building the `PrInfo` object (around 257-275).

- Add `updatedAt?: string` (ISO string, as GitHub returns it) to `PrInfo` in `src/lib/pr-info.ts`, with a doc comment: "Last activity on the PR, from GitHub. Absent when unknown."
- Also update whatever electron-side mirror type exists. Grep for `interface PrInfo` in `electron/`.
- Populate it in `electron/github.ts`.
- If there are PR equality or diff helpers (grep `prInfoEqual` or similar in `src/`), decide whether `updatedAt` should count. It should **not** trigger re-renders or notifications on its own. Exclude it from change detection used for PR notifications (ADR-147) if such a comparison exists.

## 2. `StatsSummary.dailyPrsMerged`

`electron/stats-store.ts` keeps `days: Record<string, DayBucket>`, keyed by local `YYYY-MM-DD`. The summary already builds `dailyPrompts`.

- Add `dailyPrsMerged: { day: string; count: number }[]` to the summary. It covers exactly the last 7 local days (today + previous 6), oldest first, **including zero days**.
- Mirror the type in `src/electron.d.ts` (`StatsSummary`), and in any renderer default or empty summary (grep `dailyPrompts` in `src/store/stats-store.ts` and tests).
- Add unit tests next to the existing stats-store tests (grep for them under `electron/`).

## Files to touch
- `src/lib/pr-info.ts` — add `updatedAt`
- `electron/github.ts` — populate `updatedAt`
- `electron/stats-store.ts` — build `dailyPrsMerged`
- `src/electron.d.ts` — `StatsSummary.dailyPrsMerged`
- `src/store/stats-store.ts` — default/empty summary if needed
- existing stats-store test file — tests for the new series
