---
title: Remote layouts drop claims on tabs that leave
status: todo
priority: medium
assignee: sonnet
blocked_by: [3, 8]
---

# Remote layouts drop claims on tabs that leave

ADR-230 D9 (gap R5).

## What to build

- **`LayoutStore.dropForeignClaims(key, before, after | null)`**
  (`electron/layout/layout-store.ts`, near `dropClaimsOnGoneTabs` at
  :888-903):
  - Reuse the same tab-difference rule, factored into a shared helper.
  - `after === null` drops every claim for `key`.
  - A missing `before` drops nothing.
  - Don't broadcast.
- **The `HostProxy` hook.** Add
  `HostProxyOptions.onLayoutMoved?(key, before, after | null)` next to
  `claimsFor` (`electron/backend/host-proxy.ts:143-146`), passed through
  `electron/backend/host-connection.ts:235,555-556`. Call it before
  `publishLayout`:
  - in `onLayoutChanged` (:660-693), with the previous `live.layout` as
    `before`, and `null` when the payload says the workspace was removed;
  - in `publishLayoutDiff` (:592-617), for changed and removed entries.
- **Wiring.** In `electron/server/create-manor-server.ts:260`, wire
  `onLayoutMoved` to `layoutStore.dropForeignClaims`.

## Tests (each must fail on the base commit)

- `electron/layout/__tests__/layout-store.test.ts`, in "claims (D4)"
  (:774), next to the remote-key test at :925:
  - `dropForeignClaims` drops a claim on a tab that left;
  - it keeps a claim on a tab that hasn't appeared yet;
  - `null` drops all claims for the key.
- `electron/server/__tests__/host-routing.test.ts`, next to :525 ("gives a
  remote workspace's layout the desktop windows' claims"). After the host
  closes the claimed tab, the next published layout has no claim for it.

## Files to touch
- `electron/layout/layout-store.ts`
- `electron/backend/host-proxy.ts`, `electron/backend/host-connection.ts`
- `electron/server/create-manor-server.ts`
- Tests named above.
