---
title: E2E coverage and docs
status: todo
priority: medium
assignee: sonnet
blocked_by: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]
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
