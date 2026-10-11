---
title: Lifecycle-scoped resync registration in stores
status: todo
priority: medium
assignee: sonnet
blocked_by: [6, 7]
---

# Lifecycle-scoped resync registration in stores

The "load once, reload on `onBridgeResync`" pattern is written ~7 times in three shapes, and two stores register outside the lifecycle that owns the fetch.

Do:
1. Add `bootAndResync(load: () => void | Promise<unknown>): () => void` to `src/bridge/resync.ts` (calls `load()` now, subscribes `load` to `onBridgeResync`, returns unsubscribe). Use it in preferences-store, host-store, remote-control-store, notification store (grep `onBridgeResync`), agent-store (keep `consumePruneNotice` boot-only — only the refetch part resyncs).
2. `src/store/agent-activity-store.ts` (~31-47): delete exported `refetchAgentActivity` and its `stopActive` guard; inside `startAgentActivitySync` register `onBridgeResync(() => api.get().then(set))` and unsubscribe in `stopActive`.
3. `src/store/ports-store.ts` (~95-103): move the module-level resync listener into `startScanner` beside `onChange`, unsubscribe in its stop function; drop the `as ActivePort[]` cast.
4. `src/store/theme-store.ts` (~106-113): route both `onChanged` and resync through one `applyServerTheme({ name, theme })` so the project-override rule lives in one place; resync = `Promise.all([get, getSelectedName]).then(applyServerTheme)`.
5. Update `src/bridge/__tests__/resync.test.ts`, `src/store/__tests__/agent-store-resync.test.ts` and add tests for agent-activity/ports unsubscribing on stop.

## Files to touch
- `src/bridge/resync.ts`
- `src/store/{agent-activity,ports,theme,preferences,host,remote-control,agent}-store.ts`, notification store
- tests under `src/bridge/__tests__/`, `src/store/__tests__/`
