---
title: Badge definitions, evaluation, and badge-unlocked notifications
status: todo
priority: medium
assignee: sonnet
blocked_by: [1]
---

# Badge definitions, evaluation, and badge-unlocked notifications

ADR-168 §4.

## Required behavior

`electron/stats-badges.ts` (pure):

- `export interface BadgeDef { id: string; title: string; description: string; earned: (s: StatsSummary) => boolean }`.
- `export const BADGES: readonly BadgeDef[]` with exactly the twelve entries in the ADR table, in that order. Descriptions are one short sentence each, e.g. First Blood: "Killed your first agent mid-thought."
- `export function evaluateBadges(summary: StatsSummary, awarded: Record<string, string>): BadgeDef[]` returns defs whose `earned(summary)` is true and whose id is not in `awarded`, in `BADGES` order.

`electron/stats-store.ts`:

- Constructor gains `opts.onBadge?: (badge: BadgeDef) => void`.
- After every successful `record`/`recordMax` (and inside `observeHookEvent` once per call), run `evaluateBadges(this.getSummary(), this.badges)`; for each result call `awardBadge(id)` then `onBadge(def)`. Never evaluate when disabled.

`electron/notification-store.ts`:

- Add `"badge-unlocked"` to `NotificationKind` and to whatever exhaustive validation `isValidRecord` performs.

`electron/app-lifecycle.ts`:

- Pass `onBadge: (b) => notificationStore.append({ kind: "badge-unlocked", title: \`Badge unlocked: ${b.title}\`, body: b.description, target: null })` and re-broadcast via `sendNotificationsUpdate(mainWindow)`.

`src/electron.d.ts`: mirror the new kind in the renderer `NotificationKind` union. `src/components/notifications/NotificationsPopover.tsx`: give the new kind an icon (lucide `award`) in whatever kind→icon map exists; if none exists, no UI change.

## Tests

- `electron/__tests__/stats-badges.test.ts`: every badge has a unique id; each predicate flips at its threshold (build a `StatsSummary` fixture helper); `evaluateBadges` skips already-awarded ids and preserves order.
- Extend `stats-store.test.ts`: recording the 1st kill fires `onBadge` once with `first-blood`; the 2nd kill does not fire again; disabled store never fires.
- `notification-store.test.ts`: a `badge-unlocked` record survives a load round-trip.

## Files to touch
- `electron/stats-badges.ts` — new
- `electron/stats-store.ts` — evaluate after record, `onBadge`
- `electron/notification-store.ts` — new kind
- `electron/app-lifecycle.ts` — `onBadge` wiring
- `src/electron.d.ts` — kind union
- `src/components/notifications/NotificationsPopover.tsx` — icon, if a kind map exists
- `electron/__tests__/stats-badges.test.ts` — new
- `electron/__tests__/stats-store.test.ts` — extend
- `electron/__tests__/notification-store.test.ts` — extend
