---
title: Layout resync drops removed workspaces and refreshes pane sessions
status: done
priority: medium
assignee: sonnet
blocked_by: [2]
---

# Layout resync drops removed workspaces and refreshes pane sessions

Follow-up from ticket 2. `resyncLayout()` in `src/store/app-store.ts` currently has two gaps:

- It feeds each `layout.getAll()` entry through `applyLayoutChanged`.
- It never **drops** a workspace that the server no longer lists. A `removed` broadcast missed during the drop leaves a ghost workspace on the phone.
- It does not re-seed pane cwds, titles or agent statuses from `paneSessions` the way `loadPersistedLayout` does.

What to do:
1. After applying the entries, find every workspace in the store that is absent from the `getAll()` result. Remove it through the same path a `removed` broadcast takes, as if that broadcast had arrived. Do not touch workspaces created locally in the last few seconds that the server may not know about yet: check how optimistic workspace creation works and keep those safe.
2. Re-seed pane cwd, title and agent status from `paneSessions` the same way `loadPersistedLayout` does. Extract that seeding into a shared helper rather than copying it.
3. Extend `src/store/__tests__/app-store-layout-resync.test.ts`:
   - a workspace missing from the server is removed,
   - pane status from `paneSessions` is applied,
   - an in-flight local creation is not removed.

## Files to touch
- `src/store/app-store.ts`
- `src/store/__tests__/app-store-layout-resync.test.ts`
