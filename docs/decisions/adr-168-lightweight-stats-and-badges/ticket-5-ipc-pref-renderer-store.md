---
title: Stats IPC, statsEnabled preference, preload, renderer cache store
status: todo
priority: high
assignee: sonnet
blocked_by: [2, 4]
---

# Stats IPC, statsEnabled preference, preload, renderer cache store

ADR-168 §5. Follow the ADR-162 notification pattern file for file.

## Required behavior

**Preference** `statsEnabled: boolean`, default `true`:
- `electron/preferences.ts` — interface + defaults (+ migration guard if the loader validates keys).
- `src/electron.d.ts` `AppPreferences` and `src/store/preferences-store.ts` defaults.
- Replace the defensive read in `app-lifecycle` (ticket 2) with `preferencesManager.get("statsEnabled")` or the equivalent accessor.

**IPC** `electron/ipc/stats.ts`, `register(deps)`:
- `stats:getSummary` → `statsStore.getSummary()`.
- `stats:reset` → `statsStore.reset()` then broadcast.
- Subscribe `statsStore.onChange` at register time; broadcast `stats:changed` with `getSummary()` to every window from `deps.getRendererWindows()`, debounced 1 000 ms trailing.
- Register in `app-lifecycle.ts` after `notificationsIpc.register(ipcDeps)`.

**Preload** `electron/preload.ts`: `stats: { getSummary, reset, onChanged(cb) }` using the existing `onChannel` helper.

**Types** `src/electron.d.ts`: `StatCounter`, `StatGauge`, `DayBucket`, `StatsSummary` (renderer mirrors, as `NotificationRecord` is mirrored) and the `stats` API on `ElectronAPI`.

**Renderer store** `src/store/stats-store.ts`: zustand, `{ summary: StatsSummary | null; loaded: boolean; reset(): Promise<void> }`. Subscribes to `onChanged` at creation and fetches `getSummary()` once on creation, same shape as `notification-store.ts`. Export a `formatUnblockLatency(summary: DayBucket): string | null` helper (`unblockMsTotal / unblocks`, humanised to `"4s"` / `"1m 12s"`, null when `unblocks` is 0) and `humanCounterLabel(counter: StatCounter): string` for the UI ticket.

## Tests
- `src/store/__tests__/stats-store.test.ts`: `onChanged` updates `summary`; `formatUnblockLatency` cases; `humanCounterLabel` covers every `StatCounter` (exhaustive switch so a new counter fails typecheck).
- `electron/__tests__/preferences-migration.test.ts`: `statsEnabled` defaults true for a legacy file.

## Files to touch
- `electron/preferences.ts` — pref
- `electron/ipc/stats.ts` — new
- `electron/app-lifecycle.ts` — register, read pref
- `electron/preload.ts` — API
- `src/electron.d.ts` — types + API + pref
- `src/store/preferences-store.ts` — default
- `src/store/stats-store.ts` — new
- `src/store/__tests__/stats-store.test.ts` — new
- `electron/__tests__/preferences-migration.test.ts` — extend
