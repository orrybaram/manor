---
title: Stores re-fetch on bridge resync
status: done
priority: high
assignee: sonnet
blocked_by: [1]
---

# Stores re-fetch on bridge resync

Implement ADR-220 D2. In each store, register with `onBridgeResync` (from `src/bridge/resync.ts`) next to the existing push subscription. The callback re-fetches state and applies it the same way the boot fetch does. **It must not repeat one-time side effects.**

- **`src/store/agent-store.ts`**
  - `init` (:110) fetches `getActive`, `getAll`, `getUnseen`, then calls `consumePruneNotice()`.
  - Split it so a `refetch()` does only the three fetches and applies them. `init` = `refetch()` + `consumePruneNotice()`.
  - Register `refetch`.
- **`src/store/notification-store.ts`**: `init` (:55) → register the `getAll` fetch.
- **`src/store/preferences-store.ts`** (:37): pull the inline `getAll` into a function and register it.
- **`src/store/host-store.ts`** (:52): same for `hosts.list()`.
- **`src/store/remote-control-store.ts`** (:48): same for `getStatus()`.
- **`src/store/project-store.ts`**: register `() => useProjectStore.getState().loadProjects()`.
- **`src/store/theme-store.ts`**: register `loadTheme`.
- **`src/store/agent-activity-store.ts`**: re-run the `agentActivity.get()` fetch. `startAgentActivitySync` is idempotent, so add a separate refetch function rather than calling it.
- **`src/store/ports-store.ts`**: on resync, if the scanner is acquired (ref count > 0), call `ports.scanNow()` again.
- **`src/store/app-store.ts`, layout. Be careful here.**
  - Do **not** re-run `loadPersistedLayout`: it sets the active workspace and runs `reconcileStale`.
  - Instead fetch `layout.getAll()` and feed every entry through the same path as `applyLayoutChanged` (the `layout.onChanged` handler), so the version check decides what wins and the local viewport is kept.
  - Read `loadPersistedLayout` (:1616) and `applyLayoutChanged` to find the right seam. If the shapes differ, write a small adapter.

Tests:
- Add a unit test for the layout resync: a stored entry with a newer version is not overwritten by an older one from `getAll`, and an entry with an older local version is replaced.
- Add a unit test for agent-store: the resync re-fetches but does not call `consumePruneNotice`.
- Follow the existing store test patterns: grep for `agent-store.test` or `app-store` tests.

## Files to touch
- `src/store/agent-store.ts`
- `src/store/notification-store.ts`
- `src/store/preferences-store.ts`
- `src/store/host-store.ts`
- `src/store/remote-control-store.ts`
- `src/store/project-store.ts`
- `src/store/theme-store.ts`
- `src/store/agent-activity-store.ts`
- `src/store/ports-store.ts`
- `src/store/app-store.ts`
- tests next to the above
