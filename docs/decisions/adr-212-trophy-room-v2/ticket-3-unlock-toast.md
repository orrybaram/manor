---
title: Pill unlock toast
status: todo
priority: medium
assignee: sonnet
blocked_by: [1, 2]
---

# Pill unlock toast

Build the unlock toast from ADR-212, following board 6b `V2Toasts`.

## Behavior
- `src/components/achievements/useBadgeUnlocks.ts`
  - Subscribe to `useStatsStore`. The first non-null summary is only a baseline.
  - After that, diff `Object.keys(summary.badges)` against the previous snapshot. For each new id, enqueue `{kind:"badge", id}`.
  - Also compare `trackState` sealed/gilded per section before and after, and enqueue `{kind:"seal"|"gild", section}` for each that turned true. Badge toasts come first.
  - Keep the queue in a small zustand store or a ref inside a provider.
- `src/components/achievements/UnlockToast.tsx`, mounted once in `src/App.tsx`.
  - Shows one item at a time, bottom-center and above other content.
  - The pill is ~560×88: a 64px medal with the badge emoji, ringed in the tier color (bronze/silver/gold/platinum, from theme-friendly vars); an eyebrow, "ACHIEVEMENT UNLOCKED", "TRACK SEALED" or "TRACK GILDED"; the name or title; and the tier label on the right.
  - Animation: the medal pops with a ring pulse at 0ms, the pill width unrolls by 250ms, text fades up by 450ms, holds until 5s, then rolls back and fades. Use CSS keyframes in `UnlockToast.module.css`.
  - With `prefers-reduced-motion`, show and hide with no animation.
  - `role="status"`. It is a `Button`-wrapped click target: clicking opens the command palette's stats view focused on that badge's track (reuse the navigation from `src/utils/notification-navigation.ts`, plus ticket 2's focus mechanism), then dismisses.
  - Hover pauses the timer.
- No sound. Don't change the notification-store behavior.
- Unit test the diff and queue logic: baseline is not replayed, several unlocks queue in order, and seal is detected.

## Files to touch
- `src/components/achievements/useBadgeUnlocks.ts` (new)
- `src/components/achievements/UnlockToast.tsx` (new)
- `src/components/achievements/UnlockToast.module.css` (new)
- `src/components/achievements/__tests__/useBadgeUnlocks.test.ts` (new)
- `src/App.tsx`
