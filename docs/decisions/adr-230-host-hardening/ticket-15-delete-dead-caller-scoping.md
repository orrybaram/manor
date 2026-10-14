---
title: Delete the dead callerHostId scoping
status: done
priority: low
assignee: sonnet
blocked_by: []
---

# Delete the dead callerHostId scoping

ADR-230 D15 (gap S2). Nothing in production sets `callerHostId` since
ADR-227 D8. This is a refactor with no behaviour change.

## What to do

1. **First**, in `electron/routes/context.ts:101-103`, replace the live
   `callerMaySee(callerHostId, …)` exact-host filter with
   `normalizeHostId(p.hostId) === <the resolved host>`. Run the context
   tests.
2. Delete `electron/routes/caller-host.ts`.
3. Remove `callerHostId` from `RouteDeps` and `ServerRouteDeps`
   (`electron/routes/types.ts:26-34, 44`), and remove every relayed branch:
   - `electron/routes/workspace-host.ts` (:7, 13-16, 21, 27-33);
   - `electron/routes/panes-viewport.ts:17`;
   - `electron/routes/projects.ts`: the import, `withGroupMembers`'s
     parameter and filters, `WorkspaceTargetRequest.callerHostId`, the
     member filter, `onHost(callerHostId) ??`, the 403 block, and the
     passes at :332 and :568;
   - `electron/routes/context.ts`: `relayedFrom` and `deps.callerHostId ??`.
4. Fix the comments in `electron/ipc/types.ts:158-159` and
   `electron/host-server/cli-relay.ts:17,158`.
5. Delete the relayed-only tests:
   - in `workspace-host.test.ts`: the test at :43-47 and both "relayed"
     describes;
   - in `context.test.ts`: :86-101, :155-178 and :197-205;
   - in `projects.test.ts`: the `callerHostId` parameter on `deps` and
     `batchCall`, the tests at :166, 183, 232, 316, 335 and 437, and the
     relayed half of :389-391.
6. Keep every local-caller test.

Line numbers are as of `b128a6fa`. Grep for `callerHostId` and
`callerMaySee` to be sure none remain, apart from the ADR text.

## Tests

No new tests. All route tests that remain must pass, and `tsc` must be
clean.

## Files to touch
- `electron/routes/caller-host.ts` (deleted), `types.ts`, `workspace-host.ts`, `panes-viewport.ts`, `projects.ts`, `context.ts`
- `electron/ipc/types.ts`, `electron/host-server/cli-relay.ts` (comments)
- `electron/routes/workspace-host.test.ts`, `context.test.ts`, `projects.test.ts`
