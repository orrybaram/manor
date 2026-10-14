---
title: E2E for idle stop counting phones (ADR-230 D1)
status: todo
priority: medium
assignee: sonnet
blocked_by: [6]
---

# E2E for idle stop counting phones

ADR-231 D6, item D1. The new spec is `tests/e2e/host-idle-stop.spec.ts`.
There is no product change: the real `idleStopMinutes` and
`IDLE_STOP_RECHECK_MS` are what get tested.

## What to build

- **The recipe host** from ticket 6, with `idleStopMinutes: 1`.
- **The relay.** A local relay and a phone paired with the **host**
  directly: `withLocalRelay`, `pointHostServerAtRelay`, `pairHostPhone`.
  Model it on `host-server.spec.ts`.
- **No agent runs on the box.** An agent would make it busy
  (`electron/host-server/server.ts:320-340`). The pane runs a plain shell.

The steps:
1. Open a remote project on the host, with a pane. Pair the phone with the
   host, and open that pane on the phone. Wait until it shows the pane's
   output.
2. On the desktop, switch to a local workspace, or close the remote tab,
   so no desktop window has the host's pane mounted. Confirm with
   `hosts.serverStatus` (or however the desktop reads `viewing`) that
   `viewing.device` is true and `viewing.desktop` false.
3. For 150 s:
   - the host stays `connected`;
   - the recipe's `stop.sh` doesn't run. Make it append to `stop-count` in
     its folder, through ticket 6's helper or a local tweak.
4. Close the phone page. Within 90 s the host reads `sleeping`, and
   `stop-count` is 1.

The test timeout is about 6 minutes. Put a comment at the top saying why it
is slow and how to skip it (`--grep-invert "idle stop"`).

Add it to `PLAYWRIGHT_SUITES`.

## Verify

It passes twice on the private sshd. Needs `pnpm build:web:relay`.

## Files to touch
- `tests/e2e/host-idle-stop.spec.ts` (new).
- `tests/e2e/helpers/recipe-host.ts`: a `stop-count` option, if ticket 6 didn't add it.
- `scripts/test-remote-e2e.mjs`: `PLAYWRIGHT_SUITES`.
