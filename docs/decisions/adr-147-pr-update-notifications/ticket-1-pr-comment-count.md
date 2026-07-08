---
title: Add commentCount to PR data
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Add commentCount to PR data

Extend the PR data pipeline so a comment count is fetched and carried through to
the renderer store, enabling "new comment" detection later.

## Files to touch

- `electron/github.ts`
  - Add `commentCount?: number` to the `PrInfo` interface.
  - In `getUnresolvedThreadCount`, extend the GraphQL query to also request
    `comments { totalCount }` and `reviews { totalCount }` on the `pullRequest`.
    Return both the unresolved thread count **and** a comment count. The
    cleanest approach: change this method to return an object
    `{ unresolvedThreads?: number; commentCount?: number }` (rename to something
    like `getPrConversationState`), and update the single caller in
    `getPrForBranchInner` to destructure both. `commentCount` = issue
    `comments.totalCount` + `reviews.totalCount`. On any failure, both fields are
    `undefined` (preserve existing try/catch-returns-undefined behavior).
  - Include `commentCount` in the object returned by `getPrForBranchInner`.

- `src/hooks/usePrWatcher.ts`
  - In `fetchPrs`, add `commentCount: pr.commentCount` to the object passed to
    `updateWorkspacePr`.

- `src/store/project-store.ts`
  - Add `commentCount?: number` to the renderer-side `PrInfo` interface
    (around lines 145-161).
  - Ensure `updateWorkspacePr` (lines ~713-725) carries the field through (it
    likely spreads/assigns the incoming object — confirm `commentCount` is
    persisted onto `ws.pr`).

## Notes
- Do NOT change the polling interval or add a separate `gh` call — fold the
  count into the existing GraphQL query to avoid extra network round-trips.
