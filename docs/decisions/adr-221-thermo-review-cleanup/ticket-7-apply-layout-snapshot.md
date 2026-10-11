---
title: applyLayoutSnapshot shared by boot and resync
status: todo
priority: high
assignee: opus
blocked_by: []
---

# applyLayoutSnapshot shared by boot and resync

Supersedes ADR-220 ticket 6.

`resyncLayout` (`src/store/app-store.ts` ~2554-2596) replays each `layout.getAll()` entry as a fake broadcast with an invented origin `{ kind: "route", id: "resync" }`. Its comment (and ADR-220) claim `loadPersistedLayout` "picks the active workspace and reconciles stale agents" — false: `reconcileStale` and the active pick are in `src/App.tsx` (~122-155). `loadPersistedLayout` (~1617-1684) is a merge of entries: version guard, layouts, claims, viewports, `paneSessions` seeding of cwd/title/agent status. Resync drops `paneSessions` and never removes workspaces the server no longer lists.

Do:
1. Extract the merge into `applyLayoutSnapshot(entries, opts)` in a new module next to `sessionSideMaps` / `reconcileFor` (find their file). It must: apply layouts/claims/viewports (resync repairs the local viewport, never replaces it — keep the existing rule; expose as an option), seed `paneSessions`, and drop workspaces absent from the snapshot through the same path a `removed` broadcast uses. Protect workspaces created locally and not yet known to the server (study optimistic workspace creation; e.g. skip ones with a pending create).
2. `loadPersistedLayout` = fetch → `applyLayoutSnapshot` → `layoutLoaded`. `resyncLayout` = fetch → `applyLayoutSnapshot`. Delete the fake origin. Fix the wrong comment. Net lines in `app-store.ts` should go down.
3. Tests: extend `src/store/__tests__/app-store-layout-resync.test.ts` — server-removed workspace is dropped, `paneSessions` status applied, in-flight local creation kept, local viewport kept. Existing boot tests stay green.

## Files to touch
- `src/store/app-store.ts`
- `src/store/layout-snapshot.ts` (new, or beside the existing side-map helpers)
- `src/store/__tests__/app-store-layout-resync.test.ts`
