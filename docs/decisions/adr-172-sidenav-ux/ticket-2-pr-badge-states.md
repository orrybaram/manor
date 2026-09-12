---
title: PR badge — quiet pending icon and a review-required state
status: done
priority: medium
assignee: sonnet
blocked_by: []
---

# PR badge — quiet pending icon and a review-required state

Two independent fixes to the sidebar PR badge. No sidebar-structure files are
involved; this ticket touches only `pr-readiness` and `PrPopover`.

## 1. One pending icon, quieter

Today `badgeIcon()`'s default branch returns a spinning yellow `LoaderCircle`
when `pr.checks.pending > 0`, while the popover's summary row draws a static
`Clock` for the same fact. Two problems: the icons disagree, and a spinning
yellow ring is the *agent* spinner everywhere else in the app.

- Return `{ Icon: Clock, spin: false, tone: styles.prIconPending }` for the
  pending-checks case.
- Add `.prIconPending` to `PrPopover.module.css`:
  `--pr-badge-icon: color-mix(in srgb, var(--yellow, #eab308) 55%, var(--text-dim));`
- Leave the `queued` (merge-queue) spinner alone — it is accent-coloured and a
  merge queue genuinely is a machine working.
- Leave the popover's summary row as it is; it already uses `Clock`.

## 2. `review` readiness

`prReadiness()` currently returns `pending` for an open, non-draft PR with
clear CI, no unresolved threads and `reviewDecision === "REVIEW_REQUIRED"` —
the badge shrugs while the popover says "Review required" right next to it.

In `src/lib/pr-readiness.ts`, add `"review"` to `PrReadiness` and evaluate it
after `queued`, before `ready`:

```
merged → closed → blocked → queued → review → ready → pending
```

A PR is `review` when: not draft, `checksClear`, no `unresolvedThreads`, and
`reviewDecision === "REVIEW_REQUIRED"` exactly. Any other `reviewDecision`
(including `null`, which is what repos with no required review report) keeps
today's answer. Update the doc comment's ordering note.

Then in `PrPopover.tsx`:
- `badgeClass` map gains `review: styles.prReview`.
- `badgeIcon()` gains a `case "review"` returning
  `{ Icon: ShieldQuestion, spin: false, tone: styles.prIconPending }` —
  `ShieldQuestion` is already imported and is what the popover's own "Review
  required" row uses.
- `isLive` already covers it (it is neither merged nor closed); confirm.

`PrPopover.module.css` gains `.prReview`, a lighter tint than `.prBlocked` so
the two read as different states:

```css
.prReview {
  background: color-mix(in srgb, var(--yellow, #eab308) 10%, transparent);
  --pr-badge-icon: color-mix(in srgb, var(--yellow, #eab308) 70%, var(--text-dim));
}
```

Keep the comment style of the file: say *why* the tint is lighter.

## Tests

`src/lib/__tests__/pr-readiness.test.ts`:
- `REVIEW_REQUIRED` + clear CI + no threads + not draft → `"review"`
- draft with `REVIEW_REQUIRED` → `"pending"`
- `REVIEW_REQUIRED` + pending checks → `"pending"`
- `REVIEW_REQUIRED` + failing checks or unresolved threads → `"blocked"`
- `REVIEW_REQUIRED` + `queuedToMerge` → `"queued"`
- `reviewDecision: null` with clear CI → still `"pending"` (unchanged)

## Files to touch
- `src/lib/pr-readiness.ts` — `"review"` in the union and the ladder
- `src/lib/__tests__/pr-readiness.test.ts` — cases above
- `src/components/sidebar/PrPopover.tsx` — `badgeClass`, `badgeIcon` pending + review branches
- `src/components/sidebar/PrPopover.module.css` — `.prIconPending`, `.prReview`

## Verify
`pnpm test:unit` and `pnpm lint` pass.
