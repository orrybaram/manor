---
title: Taps for agents killed, worktrees, and PR outcomes
status: todo
priority: high
assignee: sonnet
blocked_by: [2]
---

# Taps for agents killed, worktrees, and PR outcomes

Increment the remaining counters at their IPC / notification seams (ADR-168 §2 rows 2–4, §3).

## Required behavior

**Agents killed** (`electron/ipc/agents.ts`, `electron/ipc/processes.ts`), using `isKill` from `electron/stats-signals.ts`:

- `agents:abandonForPane`: after resolving `agent` and before the `updateAgent` call, `if (isKill(agent)) deps.statsStore.record("agentsKilled")`. Keep the existing early return for non-active agents.
- `processes:killSession`: before `backend.pty.kill(sessionId)`, look up `agentManager.getAgentByPaneId(sessionId)`; if found and `isKill(agent)`, record. Do not otherwise change the handler.
- `processes:killAll`: inside the loop over listed sessions, same lookup + predicate per session, before each kill.
- `agents:reconcileStale`: untouched. Not a kill.

**Worktrees** (`electron/ipc/projects.ts`):

- `projects:createWorktree`: `await` the manager call; on success `record("worktreesCreated")`; rethrow on failure.
- `projects:removeWorktree`: same with `worktreesRemoved`.
- `projects:quickMergeWorktree`: same with `worktreesMerged`. If the manager returns a result object with a failure flag rather than throwing, only count on the success shape; read `persistence.ts` to confirm which.

**PR outcomes** (`electron/notifications.ts`): at the single site that appends `pr-*` notification records (the `kind` map around line 22 and the `notificationStore?.append` around line 196), record `prApproved`, `prChangesRequested`, or `prChecksFailed` for the matching kinds. `pr-comment` is not counted. This module uses a module-level `setNotificationStore`; add a parallel `setStatsStore(store | null)` and call it from `app-lifecycle` right after `setNotificationStore`.

## Tests

- Extend `electron/__tests__/agents-abandon-for-pane.test.ts`: kill recorded for `working`/`thinking`/`requires_input`, not for `responded`, not for non-active. Use a fake `statsStore` with a `record` spy in the deps fixture.
- New `electron/__tests__/processes-kill-stats.test.ts`: `killSession` and `killAll` record once per killed active agent.
- Extend an existing projects IPC test if one exists; otherwise add `electron/__tests__/projects-worktree-stats.test.ts` covering created / removed / merged and that a throwing manager records nothing.

## Files to touch
- `electron/ipc/agents.ts` — kill tap
- `electron/ipc/processes.ts` — kill taps
- `electron/ipc/projects.ts` — worktree taps
- `electron/notifications.ts` — PR taps + `setStatsStore`
- `electron/app-lifecycle.ts` — call `setStatsStore(statsStore)`
- `electron/__tests__/agents-abandon-for-pane.test.ts` — extend
- `electron/__tests__/processes-kill-stats.test.ts` — new
- `electron/__tests__/projects-worktree-stats.test.ts` — new
