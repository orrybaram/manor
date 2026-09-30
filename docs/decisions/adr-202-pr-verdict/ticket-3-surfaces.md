---
title: Popover badge and Needs you card read the blocker
status: todo
priority: medium
assignee: sonnet
blocked_by: [2]
---

# Popover badge and Needs you card read the blocker

Implement ADR-202 §3 (UI) and §4 (colour rule).

- `src/components/sidebar/PrPopover.tsx`
  - `const verdict = prVerdict(pr); const readiness = verdict.readiness;`
  - Rewrite `badgeIcon(verdict, pr)`. For blocked, look up the icon in `const BLOCKER_ICON: Record<PrBlocker["kind"], typeof GitPullRequest>` (conflicts → GitMergeConflict, checks → CircleX, changes-requested → ShieldAlert, threads → MessageSquare) and the tone in `PR_BLOCKER[kind].tone` via `{ bad: styles.prIconBad, warn: styles.prIconWarn }`. The pending clock shows when `verdict.stage === "checks"`, otherwise the draft or plain PR icon. Remove the "Mirrors the order…" comment and keep the ADR-167 doc comment.
  - Add `data-blocker={verdict.blocker?.kind}` to the badge span.
  - Leave `SummaryRows` as it is: it lists every fact rather than the first blocker.
- `src/components/sidebar/HomeDashboard/needs-you-labels.ts`
  - Build the four blocker entries in `KIND_LABEL` from `PR_BLOCKER[kind].title`.
  - Add `export function cardColor(card: NeedsYouCard): string`. A PR card whose context kind is a blocker kind returns `TONE_COLOR[PR_BLOCKER[kind].tone]` (`bad: "var(--red)"`, `warn: "var(--yellow)"`); anything else returns `TIER_COLOR[card.tier]`. Stop exporting `TIER_COLOR` unless something else needs it (knip runs in `pnpm test`).
- `src/components/sidebar/HomeDashboard/NeedsYouCard.tsx`: use `cardColor(card)` for `--c`.
- Test: add `src/components/sidebar/HomeDashboard/__tests__/needs-you-labels.test.ts` (or match the nearest test-location convention) with a small table: conflicts/checks → red, changes-requested/threads → yellow, ready → green, input → red, finished → cyan. Build cards with minimal fixtures.

## Files to touch
- `src/components/sidebar/PrPopover.tsx`: badgeIcon on blocker kind, data-blocker
- `src/components/sidebar/HomeDashboard/needs-you-labels.ts`: titles from PR_BLOCKER, cardColor
- `src/components/sidebar/HomeDashboard/NeedsYouCard.tsx`: use cardColor
- new needs-you-labels test

Run the typecheck, `pnpm exec vitest run` and `pnpm knip:ci`.
