---
type: adr
status: accepted
database:
  schema:
    status:
      type: select
      options: [todo, in-progress, review, done]
      default: todo
    priority:
      type: select
      options: [critical, high, medium, low]
    assignee:
      type: select
      options: [opus, sonnet, haiku]
  defaultView: board
  groupBy: status
---

# ADR-124: Stale Task Reconciliation

Closes #122

## Context

When Manor restarts (e.g. after `pnpm dev` restarts due to a branch change, or after a crash), tasks that were running in PTY panes become "stale" — they remain listed as active in the sidebar even though the PTY session behind them is gone and no agent is running.

**Root cause:** Tasks are persisted with both a `paneId` and an `agentSessionId`. On restart:

1. Layout is restored from `layout.json` → the pane still exists in the layout tree
2. The PTY daemon restarts → a new PTY session is created; the old `agentSessionId` is gone
3. The `SessionEnd` hook never fires (the agent process was killed externally) → the task is never marked `completed`
4. `TasksList.tsx` only checks that `paneId` exists in the layout tree — not that the PTY session behind it matches the one the task was born in

A second issue: when a user explicitly closes a pane via `closePaneById()`, that function clears all pane-related store state (cwd, title, agent status, content type) but never touches task state. The task keeps its `paneId` reference and can become unreachable/confusing.

**What existing fixes do NOT cover:**

| Fix | What it handles | This issue |
|---|---|---|
| ADR-116 (socket path) | Daemon reconnect across versions | ❌ Old `agentSessionId` stays in `tasks.json` |
| ADR-117 (orphaned processes) | PTY sessions with no layout pane | ❌ Opposite direction |
| ADR-118 (auto-resume) | Re-launches Claude in fresh panes | ⚠️ Partial — second restart leaves it stale again |

**Key files and their roles:**
- `electron/task-persistence.ts` — `TaskInfo` interface (has `agentSessionId`, `paneId`, `status`); `unlinkPane(paneId)` exists but is never called on pane close
- `electron/terminal-host/client.ts:303` — `listSessions()` returns all live daemon sessions; never called during layout restore
- `electron/app-lifecycle.ts:476` — `SessionEnd` handler marks tasks `completed`; only fires if the agent exits cleanly
- `src/store/app-store.ts:1503` — `closePaneById()` removes pane from layout but never calls `unlinkPane()` or abandons the associated task
- `src/components/sidebar/TasksList.tsx:74` — shows task if `status === "active"` OR `paneId` is in the current layout; no session-ID check

## Decision

Two complementary fixes, each covering a different abandonment path:

### Fix A — Startup Reconciliation (main process)

After the app starts and the layout is restored, run a one-shot reconciliation in the main process:

1. Call `ptyClient.listSessions()` to get all sessions the daemon currently has alive
2. Load all active tasks from `taskManager.getTasks()`
3. For each active task whose `agentSessionId` is **not** in the live session list → mark it `"abandoned"` via `taskManager.updateTask()`
4. Broadcast the updated tasks to all renderer windows

**Where it runs:** In `app-lifecycle.ts`, triggered via a new IPC handler `reconcileStaleTasks`. The renderer calls this handler from `App.tsx` after `loadPersistedLayout()` resolves (i.e. after the layout is known and the app is ready). A small delay (500 ms) is acceptable to ensure the daemon has had time to initialize its session list.

**Why not automatic/timer-based:** Tying it to the renderer's "layout loaded" event is more deterministic than a timer and avoids running the reconciliation before layout state is available.

### Fix B — Pane Closure Hook (IPC, renderer → main)

When the user explicitly closes a pane:

1. Add IPC handler `abandonTaskForPane(paneId)` in the main process: finds the active task with `paneId`, marks it `"abandoned"`, broadcasts
2. Call this handler from `closePaneById()` in `app-store.ts` immediately before the pane is removed from the layout

This ensures that user-initiated pane closures always clean up the associated task in real time, without waiting for a restart.

### Task Status Display

Both fixes mark orphaned tasks as `"abandoned"`. The `TasksList.tsx` filter already hides `abandoned` tasks (they only show if their pane still exists in the layout, and after Fix B that pane will be gone). No UI changes are needed for the basic fix, but we add a visible "Abandoned" badge in the task row for tasks in an intermediate state where the pane still exists but the task is abandoned — consistent with how `error` status is shown.

### Tests

- Unit tests for `reconcileStaleTasks`: mock `listSessions` returning a subset of active tasks' session IDs; verify correct tasks are marked abandoned
- Unit tests for `abandonTaskForPane` IPC handler: verify it finds and marks the right task
- Unit test for `closePaneById` effect: spy on the IPC call and verify it fires with the correct paneId

## Consequences

**Better:**
- Stale tasks are cleaned up automatically on every restart — the sidebar reflects reality
- Explicit pane closes immediately clean up task state
- No manual intervention needed for the "zombie task" problem

**Risks / tradeoffs:**
- The 500 ms delay in startup reconciliation means there is a brief window where stale tasks are visible; acceptable since the sidebar loads quickly
- If the daemon is slow to start (first launch), `listSessions()` might return an empty list and mark all tasks abandoned. Mitigation: only run reconciliation if the daemon connection is confirmed healthy (check `ptyClient.isConnected()` or equivalent before calling)
- Fix B fires synchronously in `closePaneById`; if the IPC call fails, task state is inconsistent. Mitigation: fire-and-forget with a console warning; task will self-correct on next restart via Fix A

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
