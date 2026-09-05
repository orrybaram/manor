---
title: StatsStore with daily counter buckets and summary
status: in-progress
priority: critical
assignee: opus
blocked_by: []
---

# StatsStore with daily counter buckets and summary

Create the main-process `StatsStore` (ADR-168 §1) and the pure `stats-signals` predicate module. No taps or IPC yet; this ticket is the data layer plus tests.

## Required behavior

`electron/stats-store.ts`:

- Export `StatCounter`, `StatGauge`, `DayBucket`, `PersistedStats`, `StatsSummary` types exactly as in the ADR (§1). `StatsSummary = { today: DayBucket; last7Days: DayBucket; allTime: DayBucket; streakDays: number; badges: Record<string, string>; enabled: boolean }`.
- `class StatsStore` modelled on `NotificationStore` (`electron/notification-store.ts`): constructor `(dataDir?: string, opts?: { isEnabled?: () => boolean; now?: () => number })`. Loads `<dataDir>/stats.json` on construction, tolerating a missing or corrupt file (start empty). Unknown counter keys in a loaded bucket are dropped.
- `record(counter: StatCounter, n = 1): void` and `recordMax(gauge: StatGauge, value: number): void`. Both are no-ops when `isEnabled()` returns false. Both bump the current local-day bucket (`YYYY-MM-DD` computed from `now()` in local time) and schedule a 500 ms debounced save.
- `getSummary(): StatsSummary`. `today` = today's bucket; `last7Days` = sum over today and the previous 6 local days (gauges use max); `allTime` = sum/max over all buckets. `streakDays` = number of consecutive local days with `prompts >= 1`, counting back from today, or from yesterday if today has no prompts yet. Zero if neither today nor yesterday has prompts.
- `awardBadge(id: string, at = new Date(now()).toISOString()): boolean` returns false if already awarded. `getBadges()`.
- `onChange(cb: () => void): () => void` fires after every mutating call (record, recordMax, awardBadge, reset). Used by the IPC broadcast later.
- `reset(): void` clears memory and deletes the file synchronously.
- `flushNow(): void` like NotificationStore.
- Prune to the newest 400 day buckets on load and after every save.
- Add `statsFile()` to `electron/paths.ts` returning `<manorDataDir>/stats.json` (follow `notificationsFile`).

`electron/stats-signals.ts` (pure, no imports from electron):

- `export const KILL_STATUSES: ReadonlySet<string> = new Set(["working", "thinking", "requires_input"])`.
- `export function isKill(agent: { status: string; lastAgentStatus: string | null }): boolean` → `agent.status === "active" && agent.lastAgentStatus != null && KILL_STATUSES.has(agent.lastAgentStatus)`.
- Leave a placeholder export for hook-event mapping; ticket 2 fills it in.

## Tests

`electron/__tests__/stats-store.test.ts` (vitest, tmp dir per test like `notification-store.test.ts`): persistence round-trip, corrupt file tolerated, debounced save + flushNow, local-day bucketing across a midnight boundary using injected `now`, `last7Days` window, `allTime`, streak (today, yesterday-only, gap), `recordMax` semantics, disabled → no-op, `reset` deletes file, prune at 400 days, `awardBadge` idempotent.

`electron/__tests__/stats-signals.test.ts`: `isKill` truth table (active+working → true; active+responded → false; completed+working → false; null → false).

## Files to touch
- `electron/stats-store.ts` — new
- `electron/stats-signals.ts` — new (isKill + KILL_STATUSES only)
- `electron/paths.ts` — add `statsFile()`
- `electron/__tests__/stats-store.test.ts` — new
- `electron/__tests__/stats-signals.test.ts` — new
- `electron/__tests__/paths.test.ts` — add a `statsFile` case matching the existing style
