---
title: Badge model — seal, gild, titles, secret, platinum
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Badge model — seal, gild, titles, secret, platinum

Extend the badge model per ADR-212 "Model" and "Persistence". This ticket changes data and helpers only. Don't touch the UI beyond what keeps it compiling.

## Steps
1. `src/lib/badges.ts`
   - `BadgeTier` gains `"platinum"`, and so do `TIER_ORDER` and `TIER_LABEL`.
   - `BadgeMeta` gains `gild?: boolean` and `secret?: boolean`.
   - `BadgeSectionMeta` gains `title: string`, the reward for sealing. Pick short, punchy names that fit each track's theme (Carnage → "Exterminator", Groundskeeping → "Groundskeeper", Shipping → "Release Captain", Command → "Warlord", and so on).
   - Gild flags: in each track with ≥4 badges, flag its highest-target gold badges (max 2) `gild: true`.
   - Secret flags: flag 2–4 joke or surprise badges `secret: true`, picked from the existing list (e.g. kill-mid-thought style ones).
   - Add a `platinum` badge: tier platinum, description "Earned every other badge.". Progress = other badges earned / other total. Put it in a new `BADGE_SECTIONS` entry `meta` ("Meta", "Badges about badges.", title "Platinum"). Gild and seal rules don't apply to `meta`; it is sealed when platinum is earned.
   - Pure helpers, all exported:
     - `trackState(section, summary)` → `{ earned, total, sealed, gilded, sealProgress: {current,target}, gildProgress: {current,target} }`. Sealed = all non-gild earned; gilded = sealed and all gild earned. A track with no gild badges is gilded when sealed.
     - `earnedTitles(summary)` → `{ section, title, gilded, at }[]`, sorted by the time of the seal (the latest award among the track's non-gild badges).
     - `tierTally(summary)` → per tier `{ got, of }`.
2. `electron/stats-badges.ts`: add the `platinum` BadgeDef. `earned` = every other BADGES id is present in `s.badges`. Make sure `StatsSummary.badges` is populated when `evaluateBadges` runs (check `stats-store.ts` `getSummary()`), so platinum can be awarded in the same commit cycle or the next.
3. Preferences: add `achievementTitle: string | null` (default null) and `revealedBadges: string[]` (default []) to `AppPreferences` in `src/electron.d.ts`, the main-process preferences defaults/sanitizer (find it via `statsEnabled`), and `src/store/preferences-store.ts` defaults.
4. Tests: update the sync tests in `electron/__tests__/stats-badges.test.ts` and `src/lib/__tests__/badges.test.ts`. Add tests for `trackState`, `earnedTitles` and `tierTally`, including "gild earned before seal" and the platinum award.
5. Make sure the existing `StatsView.tsx` still compiles (for example, give the new tier a color in its tier chip CSS).

## Files to touch
- `src/lib/badges.ts`
- `src/lib/__tests__/badges.test.ts`
- `electron/stats-badges.ts`
- `electron/__tests__/stats-badges.test.ts`
- `electron/stats-store.ts` (only if needed for platinum)
- `src/electron.d.ts`, `src/store/preferences-store.ts`, the main preferences file
