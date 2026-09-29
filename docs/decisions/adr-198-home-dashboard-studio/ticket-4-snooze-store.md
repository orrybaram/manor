---
title: Snooze store for Needs you cards
status: todo
priority: medium
assignee: haiku
blocked_by: []
---

# Snooze store for Needs you cards

Create `src/store/snooze-store.ts` (zustand), matching the other stores in `src/store/`:

- State: `until: Record<string, number>` (item key → epoch ms).
- `snooze(key: string, ms = 60 * 60 * 1000)` sets `until[key] = Date.now() + ms` and persists.
- `activeSnoozes(now = Date.now()): Set<string>` returns keys whose `until > now`.
- Persist to `localStorage` under `manor.home.snoozes`. Load on store creation. Drop expired entries on load and on every write. Wrap every `localStorage` access in try/catch, and fall back to in-memory.
- A hook `useActiveSnoozes()` returns the active set and re-renders when a snooze expires. Schedule a single timeout for the soonest expiry, and clear it on unmount.
- Unit tests with fake timers: snooze hides, expiry un-hides, persistence round-trip, corrupt JSON ignored.

## Files to touch
- `src/store/snooze-store.ts` — new
- `src/store/__tests__/snooze-store.test.ts` — new (or wherever store tests live)
