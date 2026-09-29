---
title: Pure selectors for per-project Up next and open PR rows
status: todo
priority: high
assignee: sonnet
blocked_by: []
---

# Pure selectors for per-project Up next and open PR rows

Add the pure selectors in `src/lib/home-dashboard.ts` and expose them from the Up next hook. This ticket makes no UI changes except switching the dashboard to the new `top`.

## `topUpNextPerProject`

```ts
export function topUpNextPerProject<T extends { projectKey: string }>(
  ranked: readonly T[],
  projectOrder: readonly string[],
  perProject: number,
): T[]
```

- Group the already-ranked items by `projectKey` and keep the first `perProject` of each group, in their existing order.
- Output the groups in `projectOrder` order. Any keys that aren't in `projectOrder` go last.
- `UpNextRow` wraps the issue (`row.issue.projectKey`). Make the selector generic over a key accessor, or run it on `UpNextIssue[]` before the rows are built. Whichever you choose, keep it pure and tested.

## `openPrRows`

```ts
export type OpenPrReadiness = Exclude<PrReadiness, "merged" | "closed">;
export interface OpenPrRow {
  pr: PrInfo; project: ProjectInfo; workspace: WorkspaceInfo;
  readiness: OpenPrReadiness; label: string;
}
export function openPrRows(projects: readonly ProjectInfo[]): OpenPrRow[]
```

- Walk the projects and workspaces in order, like `needsYouItems`. Skip workspaces with no PR and PRs whose `state !== "open"`. Dedupe by `pr.url`, keeping the first.
- Sort by readiness rank: `blocked`, `ready`, `review`, `queued`, `pending`. The sort is stable, so project and workspace order is kept within a rank.
- Pick `label` like this:
  - `blocked`: `blockedReason(pr)`, which already exists in this file.
  - `ready`: "ready to merge".
  - `review`: "needs review".
  - `queued`: "queued to merge".
  - `pending`: "draft" if `pr.isDraft`; else "checks running" if `pr.checks?.pending > 0`; else "pending".
- Use the workspace type the file already uses. Check the imports in `home-dashboard.ts`.

## Hook

In `src/components/sidebar/HomeDashboard/useUpNextIssues.ts`:
- Replace `TOP_COUNT` with `PER_PROJECT = 3`.
- Return `{ all: rows, top: <per-project cap via topUpNextPerProject>, total: rows.length, loading }`.
- Update the JSDoc.
- `HomeDashboard.tsx` keeps using `upNext.top`, so no change is needed there.

## Tests

Add cases to `src/lib/__tests__/home-dashboard.test.ts`. Follow the fixtures and style already in the file.
- `topUpNextPerProject`: caps each project, groups in project order, preserves rank order within a group, puts unknown keys last.
- `openPrRows`: skips closed and merged PRs and workspaces with no PR, dedupes by URL, orders by readiness, and produces each label, including draft and checks running.

Run `pnpm vitest run src/lib/__tests__/home-dashboard.test.ts`.

## Files to touch
- `src/lib/home-dashboard.ts`: the new selectors and types.
- `src/lib/__tests__/home-dashboard.test.ts`: the tests.
- `src/components/sidebar/HomeDashboard/useUpNextIssues.ts`: return `all` and per-project `top`.
