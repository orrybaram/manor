---
title: Dashboard selectors for pipeline, cards, headline, stats and project tiles
status: done
priority: critical
assignee: opus
blocked_by: [1]
---

# Dashboard selectors for pipeline, cards, headline, stats and project tiles

Add the pure, unit-tested selectors the new dashboard renders from. No UI in this ticket. Read the ADR (`docs/decisions/adr-198-home-dashboard-studio/index.md`) §2 and `mockup.html` in the same folder for what each section shows.

Put them in `src/lib/home-dashboard.ts`. If it passes ~700 lines, create `src/lib/home-dashboard-studio.ts` and import shared helpers. Tests go in `src/lib/__tests__/`, following the existing `home-dashboard.test.ts` style and fixtures.

## Selectors

1. **`prStage(pr): "checks" | "review" | "blocked" | "ready"`** plus **`prPipeline(projects, now)`** → `{ stage, rows: PipelineRow[] }[]` in that stage order.
   - A `PipelineRow` holds: pr, project, workspace, `label` (blocked reason / "draft" / "queued"), `checks` (from `pr.checks`: passing/failing/pending/total), `ageMs` from `pr.updatedAt` (null if absent) and `stale` (age ≥ 24h).
   - Stage rules:
     - `checks`: pending with running checks.
     - `review`: `review`, and pending drafts or pending with no running checks.
     - `blocked`: `blocked`.
     - `ready`: `ready` and `queued`.
   - Reuse `prReadiness` and `blockedReason`. Dedupe by URL like `openPrRows`. Within a stage, the oldest `updatedAt` comes first; unknown ages go last and keep project/workspace order.
2. **`needsYouCards(input, now)`** extends `needsYouItems`. Keep the tier order. Each card gets `context`, a discriminated union:
   - `{ kind: "input" }`
   - `{ kind: "error", paneTitle?: string }`
   - `{ kind: "checks", failing: { name, url }[], passing, total }` (failing names from `pr.checkRuns`)
   - `{ kind: "conflicts" }`
   - `{ kind: "changes-requested" }`
   - `{ kind: "threads", count }`
   - `{ kind: "finished", diff?: { added, removed } }` (from the workspace's `diffStats`)
   - `{ kind: "ready", approved: boolean, checksPassing, checksTotal }`

   Add an `ageMs`. Accept an optional `snoozed: ReadonlySet<string>` and drop matching item keys. Export the item-key function the UI already uses (`itemKey` in `HomeDashboard.tsx`) from lib, so snooze and render share it.
3. **`headline(counts)`** → `{ lead: string; rest: string }`. Examples:
   - lead "3 things need you." + rest "3 agents are working and 5 PRs are with reviewers."
   - lead "Nothing needs you." when zero.

   Singular/plural must be correct. Omit clauses that are zero. If everything is zero: "All clear." + "No agents running and no open PRs."
4. **`openPrStats(pipeline)`** → `{ total, oldestAgeMs, byStage: Record<stage, number> }`.
5. **`projectTiles(projects, deps)`** → one tile per top-level sidebar entry (the same grouping Up next uses; look at how `useUpNextIssues` and ADR-193 linked groups key entries). Each tile has:
   - name and color
   - `host: { label, state: "online" | "partial" | "offline" }` via `src/lib/host-status.ts`
   - `workspaces: { key, state: "needs-you" | "running" | "pr-ready" | "pr-open" | "idle" }[]` (most urgent state wins)
   - `diff: { added, removed }` summed over workspaces
   - `needsYou`, `running` and `openPrs` counts
   - `port?: { port, label }` (first listening port, passed in via deps; ticket 7 supplies it)
6. **`rankUpNext`**: after `ready-for-agent` and before sidebar order, sort by Linear `priority` (1 Urgent … 4 Low; 0/none last; GitHub issues count as none). Update its tests.

## Files to touch
- `src/lib/home-dashboard.ts` (and optionally `src/lib/home-dashboard-studio.ts`)
- `src/lib/__tests__/home-dashboard.test.ts` (and a sibling test file if you split)
- `src/components/sidebar/HomeDashboard/HomeDashboard.tsx` — only to import `itemKey` from lib instead of defining it locally
