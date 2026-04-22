---
title: Tests for the three recovery fixes
status: done
priority: high
assignee: sonnet
blocked_by: [1, 2, 3]
---

# Tests for the three recovery fixes

Extend `electron/__tests__/relay-subagent-tracking.test.ts` with cases covering each of tickets 1, 2, and 3. Read the existing test file first — match its style (helpers, assertion patterns, fake-timer usage).

## Cases to add

### Fix 1 — Terminal-status SubagentStop clears the tracker

- Open a root session, drive it to `working`.
- Fire `SubagentStart` with an active status (e.g. `working`) and a `toolUseId`.
- Fire `SubagentStop` for the same `toolUseId` with a **terminal status** (e.g. `complete` or `idle`).
- Assert: `sessionStateMap.get(root).activeSubagents.size === 0`.
- Fire parent `Stop`. Assert: the task transitions to `responded` immediately (i.e. `applyStopForSession` ran) and `pendingStopAt` is `null`. Distinguishing from the pre-fix behaviour where `Stop` would set `pendingStopAt` instead.

### Fix 2 — SessionStart on the same pane force-closes the old task

- Deliver `SessionStart` for `sessionA` on `paneX`, then drive `sessionA` to `working`.
- Deliver `SessionStart` for `sessionB` on the same `paneX`.
- Assert: the task for `sessionA` has `lastAgentStatus: "responded"` and `status: "active"` (the responded-but-still-active shape that `applyStopForSession` writes).
- Assert: `sessionStateMap.has("sessionA") === false` and `sessionStateMap.has("sessionB") === false` (sessionB hasn't received any non-SessionStart event yet — `SessionStart` itself doesn't create a session-state entry in the current code).
- Negative: `sessionA` that was created but never reached an active status (no `hasBeenActive`) should NOT be force-closed on replacement.

### Fix 3 — Orphan-task sweep

Set up a task with no matching session state:

- Seed a task directly through the fake `taskManager` with `status: "active"`, `lastAgentStatus: "working"`, `agentSessionId: "orphan-session"`, `activatedAt` set to more than `STALE_ACTIVE_MS` (1 minute) in the past.
- Do NOT add any entry to `sessionStateMap` for `"orphan-session"`.
- Call `sweepStaleSessions()`.
- Assert: the task's `lastAgentStatus` is now `"responded"`.

Add three negative cases alongside:

- **Too young**: same seeding but `activatedAt` is recent (within `STALE_ACTIVE_MS`). Sweep leaves the task unchanged.
- **Not active status**: `lastAgentStatus: "responded"` (or `"complete"`). Sweep leaves it unchanged.
- **Session state still present**: add a `SessionState` for the sessionId. Sweep's orphan branch no-ops (the session-driven branches handle it or not based on their own gates — just assert the orphan branch does not run by checking that `applyStopForSession` is not called via the orphan path; easiest way is to ensure the task is still `working` if its `SessionState` is fresh and `pendingStopAt === null`).

## Files to touch

- `electron/__tests__/relay-subagent-tracking.test.ts` — add the test cases above in the style of existing tests. Reuse `buildRelay()` / `makeFakeTaskManager()` helpers.

Ensure `npm run test -- relay-subagent-tracking` (or the project's vitest invocation) passes locally. No other files should change.
