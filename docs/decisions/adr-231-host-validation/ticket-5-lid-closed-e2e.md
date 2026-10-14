---
title: A full lid-closed E2E (freeze, cut, work, thaw)
status: todo
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
