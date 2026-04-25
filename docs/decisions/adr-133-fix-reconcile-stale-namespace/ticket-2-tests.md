---
title: Update reconcileStale tests for paneId namespace
status: done
priority: high
assignee: sonnet
blocked_by: [1]
---

# Update reconcileStale tests for paneId namespace

`electron/__tests__/tasks-reconcile-stale.test.ts` currently passes opaque strings (`"s1"`, `"s2"`) for both `agentSessionId` and `listSessions().sessionId`, hiding the namespace bug. Update the suite to assert the correct semantic and add a regression case that uses realistic, distinct values for the two namespaces.

## What to change

1. Update `makeTask` to accept and emit `paneId` (alongside or replacing `agentSessionId`).
2. Rework the existing tests to set `paneId` on the task and have `listSessions().sessionId` match `paneId` (live) or not (dead).
3. Add a **regression test**: a task whose `agentSessionId` is a UUID like `"agent-uuid-1"` and `paneId` is `"pane-1"`; `listSessions()` returns `[{ sessionId: "pane-1" }]`. The task must **not** be abandoned, even though `liveIds` does not contain `"agent-uuid-1"`. This is the case that the old code mishandled.
4. Add a test for the new `task.paneId === null` skip: an active task with `paneId: null` and any `listSessions()` response must not be touched.

## Files to touch

- `electron/__tests__/tasks-reconcile-stale.test.ts` — update fixtures and assertions per above.

## Verification

After this ticket lands, the test suite must:
- pass on the implementation from ticket 1, and
- fail on `git stash`-ed (pre-fix) `electron/ipc/tasks.ts` (i.e. detect the original namespace bug).

Confirm both directions before marking done.
