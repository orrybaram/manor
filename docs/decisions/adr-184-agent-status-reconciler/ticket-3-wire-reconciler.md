---
title: Wire the reconciler in main and publish status + reason
status: todo
priority: high
assignee: opus
blocked_by: [2]
---

# Wire the reconciler in main and publish status + reason

Read `index.md`. This is the switch-over ticket.

1. Create `electron/agent-status/driver.ts`, the driver. It:
   - holds `Map<paneId, PaneAgentState>`;
   - exposes `signal(paneId, StatusSignal)`;
   - runs `reconcile`;
   - applies effects exactly once per signal;
   - runs a single tick interval using the sweep cadence;
   - on host (re)connect, calls `getPaneFacts` for each known pane and feeds the results
     in.

   Reuse and extend `hook-relay-effects.ts` as the effect applier: persist, create,
   broadcast, notify, unseen and badge. Preserve the relay's effect ordering. The existing
   `hook-relay` integration tests are the parity guard, so port them to run through the
   driver.
2. Route signals into the driver:
   - **Hooks:** `ingestHookPayload`, which covers both local hooks and the remote hook-feed
     replay, calls `driver.signal` instead of `createHookRelay().relay`.
   - **Pane facts:** the `paneFacts` stream events. Handle these **once in main**, not in
     the per-window `handleStreamEvent`. Move the agent-domain side effects (rename from
     title, and anything else agent-related) out of the per-window loop into a single
     subscription.
   - **User signals:** `agents:abandonForPane`, `/sessions/end`, and the delete/end paths
     in `ipc/agents.ts` and `routes/agents.ts`. These now send `user` signals, and their
     direct `updateAgent({status…})` writes are removed.
3. Publish. The `PublishPaneStatus` effect sends `{ paneId, status, reason, kind }` on one
   IPC channel, `agent-status`, to every window. Write the reason to the agent-status debug
   log.
4. Stop using the old paths without deleting them yet (ticket 4 deletes them): main no
   longer calls `relayAgentHook` and ignores `agentStatus` stream events. `createHookRelay`
   becomes unused.
5. Tests: port the relay integration tests to the driver, add a test that one signal with
   two windows applies its effects once, add a reconnect resync test, and add user-signal
   tests.

Checks: tsc over the 3 configs (0/0/7), eslint, and vitest on `electron/` in short targeted
runs.

## Files to touch
- `electron/agent-status/driver.ts` (new), `electron/hook-relay-effects.ts` (move into `electron/agent-status/` if cleaner)
- `electron/agent-hooks.ts` (`ingestHookPayload`), `electron/backend/hook-feed.ts`, `electron/app-lifecycle.ts` (`handleStreamEvent`, wiring)
- `electron/ipc/agents.ts`, `electron/routes/agents.ts`, `electron/process-control.ts` (if it writes status)
- `electron/preload.ts`, `src/electron.d.ts` (the new `agent-status` channel; keep the old one until ticket 5)
- related tests
