---
title: E2E for restore not waking a sleeping host (ADR-230 D3)
status: todo
priority: medium
assignee: sonnet
blocked_by: [6]
---

# E2E for restore not waking a sleeping host

ADR-231 D6, item D3. The new spec is `tests/e2e/host-restore-asleep.spec.ts`.

## What to build

Don't use the `app` fixture: launch, kill and relaunch by hand. Follow
`tests/e2e/viewport.spec.ts:24-75` (`launchApp(tempHome)`, `killApp`,
`launchApp(tempHome)` again).

1. **Launch.** Register the recipe host (ticket 6), open a remote project
   on it, and mount a terminal pane. Note the pane id and `upCount` (1).
2. **Wait for the layout.** Poll until `.manor/layout.json` holds the
   pane's workspace and `viewport.json` names it as visible, as
   `viewport.spec.ts:44-58` does. `killApp` is a SIGKILL and skips the
   final save.
3. **Stop and kill.** `hosts.stop(hostId)`, wait for `sleeping`, then
   `killApp`.
4. **Relaunch** against the same `tempHome`. Assert:
   - `hosts.list` shows the host `sleeping`, for 10 s;
   - `upCount` is still 1;
   - the restored pane shows the asleep banner (`host-offline-banner`, or
     the asleep label `host-asleep-label`; check which one the pane shows
     in `HostIndicator.tsx` and `ProjectItem.tsx`).
5. **Wake it.** Click the banner's "wake it" (`host-wake`, in
   `HostStatusDetails.tsx:108`). Then `upCount` is 2, the host is
   `connected`, and the pane reattaches: a command typed in it runs on the
   box.
6. **Another workspace wakes it.** A second test: the same setup with two
   workspaces, the first one visible. After the relaunch, clicking the
   second workspace in the sidebar wakes the host (`upCount` grows, and it
   is `connected`).

Add the spec to `PLAYWRIGHT_SUITES`. Before the fix, it fails: check out
`b128a6fa`'s `useTerminalConnection.ts` in a scratch copy, or describe in
the commit message which assertion would fail and why. A full revert isn't
required.

## Verify

The spec passes 3 of 3 with `--repeat-each=3` on the private sshd.

## Files to touch
- `tests/e2e/host-restore-asleep.spec.ts` (new).
- `scripts/test-remote-e2e.mjs`: `PLAYWRIGHT_SUITES`.
