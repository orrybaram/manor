---
title: A full lid-closed E2E (freeze, cut, work, thaw)
status: done
priority: high
assignee: opus
blocked_by: [1]
---

# A full lid-closed E2E

ADR-231 D4. Read Context C2 and Decision D4 first. The new spec is
`tests/e2e/lid-closed.spec.ts`.

## What to build

- **Fixtures.** Use the relay fixture (`relayTest` / `withLocalRelay`,
  `tests/e2e/helpers/relay-fixture.ts`), `pointHostServerAtRelay`, and the
  phone helpers (`openWebApp`, `pairBrowser`). Model the phone linking on
  `phone-linked-hosts.spec.ts`: one desktop link, linked to the box's room
  on its first hello.
- **Freezing helpers,** in `tests/e2e/helpers/remote-host.ts` or a new
  `helpers/freeze.ts`:
  - `freezeApp(electronApp)` sends `SIGSTOP` to the main pid
    (`electronApp.process().pid`) and every descendant (walk
    `ps -o pid=,ppid=,comm=`), **except `ssh` processes**. It returns the
    pids it stopped.
  - `thawApp(pids)` sends `SIGCONT` to the same pids.
  - Always thaw in a `finally`, or a failed test leaves a stopped app
    behind.
- **The steps.** Follow D4's four steps exactly.
  - **The ticker pane:** a second pane running
    `i=0; while :; do i=$((i+1)); echo "tick $i"; sleep 1; done`.
  - **The phone's answer** goes into the agent pane, and the stub echoes it
    (`received: …`). Check it with `onRemote`, or the pane's text on the
    phone.
  - **Statuses on the phone.** Read them from the phone's own sidebar or
    agent list. Find the test ids the phone specs already use. Don't read
    them from the desktop's `/agents`, which is frozen.
  - **Away on the phone.** The desktop's project reads as away within 30 s
    while the box's stays live. Use the dimmed or away marker the phone
    specs already assert. If it doesn't hold, keep the assertion, mark the
    test `test.fail()` with a comment naming the cause you found, and add
    a "Found" section to this ticket. The fix is a follow-up ticket under
    ADR-231. Don't fix it here.
  - **Thaw.** After `thawApp`, never call `retryHost`. Poll `hosts.list`
    for `connected` within `30_000 + STEP`.
  - **Notifications.** Count them with the `agentNotifications` helper in
    `remote-host.spec.ts`. Move it to a helper file and share it.
  - **The ticker.** Read the pane's text through `readSession`. Every
    `tick N` from the first to the last seen appears exactly once.
- Add the spec to `PLAYWRIGHT_SUITES` in `scripts/test-remote-e2e.mjs` and
  to the file header comment.
- No fixed sleeps outside the frozen window. Use `pollFor` and
  `expect.poll`.

## Verify

- `DISPLAY=:0 node scripts/test-remote-e2e.mjs --playwright-only -- tests/e2e/lid-closed.spec.ts --repeat-each=3`
  on the private sshd: 3 of 3. Needs `pnpm build:web:relay` first.
- Then once in `--docker` (`sg docker -c …`).
- Report the counts in the commit message.

## Files to touch
- `tests/e2e/lid-closed.spec.ts` (new).
- `tests/e2e/helpers/remote-host.ts` or `tests/e2e/helpers/freeze.ts`: freeze and thaw.
- `tests/e2e/helpers/notifications.ts` (new, or an existing helper file): `agentNotifications`, shared with `remote-host.spec.ts`.
- `tests/e2e/remote-host.spec.ts`: import the moved helper.
- `scripts/test-remote-e2e.mjs`: `PLAYWRIGHT_SUITES` and the header.

## Found

**The phone does not read a frozen desktop as away.** Step 3's "desktop
reads as away within 30 s" fails on every run. The spec keeps the
assertion. It checks it last, and marks the test `test.fail()` only when
that check is the one that fails, so every other step must still pass.
Everything else in D4 holds.

What a diagnostic run showed (desktop frozen for 113 s, the phone polled
every 250 ms):

- **0 to about 90 s.** The phone's line to the desktop's room stays
  "connected". The relay answers a viewer's `HEARTBEAT_PING` itself (an
  auto-response, `relay/src/room.ts`), so the phone's heartbeat never
  notices that the desktop behind the room has gone silent. Any merged read
  (`agents.getActive`, `projects.getAll`) hangs for that whole time,
  because `router.ts`'s `merged()` waits on every server it still calls
  reachable, the frozen desktop included. The spec therefore reads agent
  statuses from the phone's sidebar (`sidebar-agent-row` / `agent-dot`),
  which the box's status events keep live.
- **At about 90 s** the relay drops the silent host (`STALE_AFTER_MS`,
  90 s, in its alarm sweep). Merged reads answer again from that point.
- **After that the project is still not dimmed** (checked up to 113 s).
  The desktop's own project has its room as its `hostId` on the phone.
  `isHostOffline` (`src/lib/host-status.ts`) marks a host away only when:
  - a host list reports the host as not connected; or
  - there is no direct bridge and every server listing the host is
    unreachable.

  No host list names the desktop's own room. The phone does hold a direct
  bridge to it, so the second rule never applies either. As far as the
  code reads, the desktop's own project is never dimmed, even once its
  socket is closed. Not verified at runtime: what `directReachability`
  returned at that point.

The fix is a follow-up ticket under ADR-231, in two parts:

1. **Liveness between phone and desktop.** A heartbeat that reaches the
   desktop end to end, or a relay that tells viewers when its host has gone
   silent, well inside 30 s.
2. **The away rule.** `isHostOffline` treats a server the page reaches
   directly and finds unreachable as away. That covers the desktop's own
   room.

When it lands, delete the `relayTest.fail` branch at the end of
`tests/e2e/lid-closed.spec.ts`.

**Two changes outside the file list:**

- **`--docker`.** The container now reaches the local relay.
  - `reachRelayFromBox` sets up an `ssh -R` on the side channel, using the
    same port at both ends.
  - Its sshd sessions source `~/.manor-e2e/env` through a `ForceCommand`
    wrapper. The image used to fix `MANOR_RELAY_URL` with `SetEnv`, so
    `pointHostServerAtRelay` had no effect there.
- **`resetRemoteBox`** also clears `~/.manor/worktrees` on the box.
