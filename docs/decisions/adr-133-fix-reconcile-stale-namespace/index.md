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

# ADR-133: Fix `reconcileStale` namespace mismatch

## Context

`tasks:reconcileStale` (`electron/ipc/tasks.ts:104-144`) is invoked from the renderer on app boot (`src/App.tsx:60`). Its purpose: walk every active task and abandon any whose underlying daemon session no longer exists — covering the case where the user quit Manor while agents were running.

Current handler shape:

```ts
liveSessions = await backend.pty.listSessions();
const liveIds = new Set(liveSessions.map((s) => s.sessionId));
for (const task of allTasks) {
  if (
    task.status === "active" &&
    task.agentSessionId &&
    !liveIds.has(task.agentSessionId) &&
    task.lastAgentStatus !== "responded"
  ) {
    // mark abandoned
  }
}
```

**The two `sessionId` namespaces don't match:**

- `task.agentSessionId` is set at `electron/hook-relay.ts:213-227` from the hook URL's `?sessionId=` parameter. The bash hook script (`electron/agent-hooks.ts:174`) extracts this from the agent payload's `"session_id"` field — i.e. the **agent CLI's** session UUID. Claude Code generates a fresh UUID per session (`abc-def-...`); Codex generates its own; Pi uses `sessionManager.getSessionId()`.
- `daemon.listSessions()` returns the daemon's pane-keyed `sessionId`, which is the **paneId** the renderer passed to `pty:create` (e.g. `pane-xyz-...`). See `electron/terminal-host/terminal-host.ts:96-100` and the `create({ sessionId, ... })` calls in `electron/ipc/pty.ts`.

These two namespaces never overlap — they have different generators, different prefixes, and serve different purposes. `liveIds.has(task.agentSessionId)` is therefore always `false` for any task that ever fired a hook. The handler abandons **every** active task with `lastAgentStatus !== "responded"` on every boot — silent corruption.

The existing test (`electron/__tests__/tasks-reconcile-stale.test.ts:79-97`) passes because the fixtures use opaque strings (`"s1"`, `"s2"`) on both sides — the namespace bug is invisible under fake data.

`task.paneId` already maps directly into the daemon's namespace; reconciliation should use it.

## Decision

Reconcile via `task.paneId` instead of `task.agentSessionId`. Skip tasks whose `paneId` is null — they were already orphaned by a prior code path (e.g. the relay's "task-by-pane already exists" branch at `hook-relay.ts:207-210`) and aren't this handler's responsibility.

```ts
const livePaneIds = new Set(liveSessions.map((s) => s.sessionId));
const allTasks = taskManager.getAllTasks();

for (const task of allTasks) {
  if (task.status !== "active") continue;
  if (!task.paneId) continue;
  if (livePaneIds.has(task.paneId)) continue;
  if (task.lastAgentStatus === "responded") continue;

  const updated = taskManager.updateTask(task.id, {
    status: "abandoned",
    completedAt: new Date().toISOString(),
  });
  if (updated) {
    // existing broadcast + dock badge update
  }
}
```

Update the test suite to use `paneId` in the fixtures and add a regression case that exercises the original namespace mismatch (task with non-paneId-shaped `agentSessionId` and matching live paneId — must NOT be abandoned).

## Consequences

**Better:**
- Active tasks with live panes survive app restart instead of being silently abandoned.
- Tasks whose pane was killed while Manor was off get correctly abandoned, as originally intended.

**Tradeoffs:**
- Tasks with `paneId: null` (already-orphaned) are now skipped here. They live on as `active` until cleaned up by the user, the relay's orphan-task sweep (ADR-132 Branch 3), or a future retention job (ADR-136). This matches the broader system: unlinked tasks already display in the sidebar's Recent / history modal regardless of `reconcileStale`.

**Risks:**
- None significant. The current handler is silently destructive; replacing it with a correct implementation cannot be worse than today's behaviour.
- One subtle case: a task whose pane was destroyed and recreated (with a new paneId) before app restart will show up here as `paneId not in liveIds` and get abandoned. Correct outcome — the original session is gone.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
