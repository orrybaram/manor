---
title: Delete the detector, relay state machine and their bridges
status: done
priority: high
assignee: sonnet
blocked_by: [3]
---

# Delete the detector, relay state machine and their bridges

Read `index.md`. Delete everything ticket 3 made unused, using grep to prove each item has
no production caller:

- **Daemon side:**
  - `electron/terminal-host/agent-detector.ts`, `title-detector.ts` and
    `output-pattern-matcher.ts`, whatever `pane-facts.ts` did not absorb, plus their tests;
  - the `agentStatus` stream event;
  - the `relayAgentHook` control request (daemon handler, client, `PtyBackend`,
    `DaemonPtyBackend`, `RoutedBackend`, host-view);
  - `session.ts`'s detector wiring, the dead pid sweep interval and the `setAltScreen`
    calls.
- **Main side:**
  - `createHookRelay`'s old interior, `hook-relay-transition.ts` (now superseded by the
    reconciler; delete it once its tests are ported) and `sweepStaleSessions`;
  - `notifyAgentDetectorGone` and its plumbing in `app-lifecycle.ts`;
  - the `pty-agent-status-*` sends.
- **Agent-kind tables:** duplicated tables that only the detector used, e.g. `KNOWN_AGENTS`
  and `KNOWN_SHELLS` if unused.

Keep every behaviour the reconciler now covers. If you find a caller that ticket 3 missed,
route it through the driver rather than keeping the old path.

Checks: tsc over the 3 configs (the electron baseline may drop below 7 if detector test
errors go away; it must never go up), eslint, and targeted vitest.

## Files to touch
- `electron/terminal-host/agent-detector.ts`, `title-detector.ts`, `output-pattern-matcher.ts` (delete) and their tests
- `electron/terminal-host/session.ts`, `types.ts`, `index.ts`, `client.ts`
- `electron/backend/types.ts`, `daemon-pty.ts`, `routed-backend.ts`, `host-view.ts`
- `electron/hook-relay.ts`, `hook-relay-transition.ts` (delete) and tests, `electron/app-lifecycle.ts`
