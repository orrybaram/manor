---
title: E2E coverage and docs
status: in-progress
priority: medium
assignee: sonnet
blocked_by: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 17]
---

# E2E coverage and docs

ADR-230, closing ticket.

## E2E

Run the remote suites before and after, and record both results:
- `node scripts/test-remote-e2e.mjs`
- `sg docker -c 'node scripts/test-remote-e2e.mjs --recipe'`

Add, where the harness can reach:
- **Recipe mode (`tests/e2e/remote-host/` recipe-host suite):**
  - **Re-up after a move (D2).** The test recipe's `up` returns a new
    container name or exec target on its second run. Force a drop, as the
    existing forced-drop test does; the host reconnects to the new target
    without a manual connect.
  - **Port-forward half-close (D4).** A server on the box replies after
    reading EOF, and a desktop client that half-closes gets the reply.
- **Remote suite:**
  - **Branch on the phone for a host-only workspace (D6).** A phone paired
    to the host sees the branch change after `git checkout -b` on the box.
  - **Restore doesn't wake (D3).** A sleeping recipe host's restored pane
    shows the asleep banner after a relaunch, and "wake it" brings it up.
    Recipe mode only; skip it if a relaunch isn't feasible in the harness,
    and say so.

Anything not reachable stays covered by the unit tests. List those gaps in
the ADR.

## Docs

- **`docs/remote-hosts.md`:**
  - idle stop now counts phones and forwarded viewers ("Asleep hosts");
  - a reconnect re-runs a recipe's `up`;
  - restored panes don't wake a host;
  - port forwards carry half-close ("Ports and forwarding");
  - update "Testing" with any new known failures.
- **ADR-228 and ADR-229 "Known limits as built":** strike the items fixed
  here, each with "Fixed in ADR-230", and leave the rest.
- **ADR-227:** strike the stats-only and `callerHostId` limits.
- **ADR-230:** add a "Known limits as built" section:
  - the 4 s grace;
  - the phone-only selection that isn't persisted;
  - a directly paired phone still competing with main;
  - version skew;
  - E2E gaps.
- Mark ADR-230 `accepted`.

## Files to touch
- `tests/e2e/remote-host/**`, `scripts/test-remote-e2e.mjs` (only if needed), the recipe fixtures
- `docs/remote-hosts.md`
- `docs/decisions/adr-227-*/index.md`, `adr-228-*/index.md`, `adr-229-*/index.md`, `adr-230-*/index.md`

## Carried over from earlier tickets

Record these in ADR-230's "Known limits as built", and in the decisions they
change:
- **Ticket 1.** `forwarded` excludes owner connections whose `viewer` is
  `"desktop"`, because a desktop viewer stream is an owner connection too.
  Update D1's wording.
- **Ticket 2.**
  - The autoSleep check lives in `RecipeHostProvider.refresh()`.
  - A declined refresh counts as this drop's re-run.
  - Callers joining an in-flight `ensureUp` don't get its progress lines.
- **Ticket 11.**
  - `pendingMints` is a list, not one slot.
  - Mints still in flight are never reconciled.
  - `createdAt` matching allows 10 min of clock skew.
  - Linked pairings now show a 6-hex suffix in the host's device list,
    e.g. "Orry's phone (a1b2c3)". Note it.
  - A reset made from elsewhere is caught by the room check. A link pointing
    at the old room is still only replaced on the phone's next hello.
- **Ticket 12.**
  - Phone-mode tests must sit last in `auto-join.test.ts` and
    `project-store-transfer.test.ts`, because a home server can't be removed
    from the server set.
  - Rows inside `ProjectSetUpOnSection`'s map and `TasksView`'s memo don't
    re-render on a pairing change alone.
- **Ticket 15.** `withWorkspaceHost` now returns a plain body.
- **Ticket 3.**
  - Only the panes of the workspace a window shows at launch decline to
    wake. Opening another workspace counts as intent. This was decided
    during implementation; update D3 to say so.
  - The router and `HostRouting` answer `{ok:false, reason:"host-unavailable"}`
    rather than throwing, so the pane reaches `awaitHost`.
  - A restored id is forgotten once its first create settles, not when it is
    sent. That keeps StrictMode double-mounts from waking the host.
  - Resync `attach()` never sends `wake: false`.
- **Ticket 10.**
  - The grid cache lives in `HostRouting` (`ptyGrids`).
  - `PtyAttachments` is now a class; `processAttachments` is the process
    instance.
  - Forwarded create, attach and reset answers always carry `winsizeOwner`.
  - Only main's local holders of a pane get per-connection owner flags.
  - A follower that creates before any grid is cached sends its own size.
- **Ticket 6.**
  - The router merges branch and diff payloads across servers, delivering
    the union trimmed per server, because the consumers treat each payload
    as the whole picture.
  - `BranchWatcher` re-emits when a connection's own list changes.
  - Only `start` and `stop` reach host servers. The phone's diff-pane reads
    (`diffs.getFullDiff`, `getLocalDiff`, `getStagedFiles`) still go home;
    record that as a known limit.
  - `refused` (an older host server) clears only on a resync or a bridge
    change.
  - The watchers moved into `SharedDeps`, and the per-connection sets live in
    `electron/watched-sets.ts`.
- **Ticket 8.** `linearConnect` validates before saving
  (`getViewer(apiKey)`), so a failed connect emits nothing.
- **Flaky tests seen.** `electron/terminal-host/__tests__/bridge-process.test.ts`
  ("keeps its daemon apart") failed twice under a full parallel run and passed
  when run alone. `exec-runner` and `TaskDetail` did the same once. List them
  in docs/remote-hosts.md#testing if they reproduce.
- **Ticket 14.**
  - The gauge is also sampled in `onRemoteAgentUpdate` through
    `statsStore.recordMax`.
  - The `onRemoteAgentUpdate` sampling has no test of its own.
