---
type: adr
status: proposed
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

# ADR-137: Pane-keyed state lifecycle

## Context

Three caches in the main process are keyed by paneId and grow monotonically. Each was added without a deletion path; together they leak memory and risk stale state across long uptimes.

### Cache 1 — `paneContextMap` (`electron/app-lifecycle.ts:77-80`)

Maps `paneId → { projectId, projectName, workspacePath, agentCommand }`. Populated by `tasks:setPaneContext` IPC (`ipc/tasks.ts:62-75`). Read by the relay (`hook-relay.ts:212`) when creating a task. **Never deleted** — there is no `tasks:clearPaneContext` handler, no entry-removal hook on pane close, nothing.

Per-pane size is small (a handful of strings). At a few hundred panes per session it doesn't matter; for users who keep Manor running for weeks across many short-lived agent panes, the map grows unbounded.

### Cache 2 — `PrewarmManager` after daemon restart

`PrewarmManager` (`electron/prewarm-manager.ts`) keeps a single warmed PTY session. `state` is `idle | warming | ready`. The session is owned by the daemon process. If the daemon dies and restarts (uncommon but possible — bug, OOM, manual restart), the prewarmed `paneId` is stale: the daemon doesn't have it, but `PrewarmManager.state` is still `"ready"`.

The next `consume()` returns the stale paneId; the next IPC for that pane (e.g. `pty:write`) fails because the daemon has no session by that id. There's a `reset()` method that clears state, but nothing calls it on reconnect.

### Cache 3 — PrewarmManager `updateCwd` race

`updateCwd` (`prewarm-manager.ts:96-102`) does:
```ts
async updateCwd(cwd: string, agentCommand?: string | null): Promise<void> {
  // ...
  await this.dispose();
  await this.warm(cwd, agentCommand);
}
```

The dispose-then-warm sequence races with an in-flight `warm()`. If `warm()` is partway through `client.createNoSubscribe(...)` when `dispose()` is called:
- `warmingPaneId` is cleared by dispose (line 107).
- The in-flight `warm()` returns from `await client.createNoSubscribe(...)`, sees `this.warmingPaneId !== paneId` (line 43), and tries to `kill(paneId)`.
- But `dispose()` already called `kill(toKill)` for the same paneId (line 115).
- Meanwhile, the freshly-issued `warm()` has incremented `state` to `warming` — the in-flight orphan's late `kill` may now race with the new pane's lifecycle if paneIds collided (they don't, randomUUID).

The actual outcome under typical timing is benign (one kill is no-op; the second wins). But the `writeAfterReady` step (line 58) is more dangerous: if dispose fires between `client.createNoSubscribe` resolving and the writeAfterReady, the dispose race will already have killed the pane, but writeAfterReady's promise might still resolve `commandInjected = true` against a dead session — meaning a future consume returns "command was injected" when it wasn't.

## Decision

Three changes, two files.

### Change 1 — Lifecycle for `paneContextMap`

Add an explicit "forget pane" path. Two trigger points:

1. New IPC `tasks:clearPaneContext(paneId)` called from the renderer when a pane is closed (mirroring `tasks:abandonForPane`).
2. Defensive cleanup in main: when `pty:close` fires (`electron/ipc/pty.ts`), clear the entry. The renderer + main both contribute so a missed renderer call is not catastrophic.

```ts
// electron/ipc/tasks.ts
ipcMain.handle("tasks:clearPaneContext", (_event, paneId: string) => {
  assertString(paneId, "paneId");
  paneContextMap.delete(paneId);
});

// electron/ipc/pty.ts (in the pty:close handler)
const handler = ipcMain.handle("pty:close", async (_event, paneId: string) => {
  // ... existing kill logic ...
  paneContextMap.delete(paneId);  // safety net
});
```

Renderer-side: `closePaneById` in `src/store/app-store.ts:1483` already calls `tasks.abandonForPane`. Add `tasks.clearPaneContext` next to it.

### Change 2 — PrewarmManager observes daemon reconnect

Wire `PrewarmManager` to the daemon's connection lifecycle. On reconnect:
1. `reset()` (clear stale state without trying to kill — the session is already gone).
2. `warm()` (start a fresh prewarm).

The daemon client (`TerminalHostClient`) currently doesn't expose a reconnect event. Add one: `client.onReconnect(callback)`. Internal triggers: when the client transitions from disconnected → connected, fire all registered callbacks.

```ts
// electron/terminal-host/client.ts
private reconnectListeners: Array<() => void> = [];
onReconnect(cb: () => void): void {
  this.reconnectListeners.push(cb);
}
private fireReconnect(): void {
  for (const cb of this.reconnectListeners) {
    try { cb(); } catch (err) { console.error("[client] reconnect listener error:", err); }
  }
}
// Call fireReconnect() inside whatever reconnect path exists today.
```

Then in `app-lifecycle.ts`:

```ts
client.onReconnect(() => {
  console.debug("[app] daemon reconnected; resetting prewarm");
  prewarmManager.reset();
  prewarmManager.warm().catch(() => {});
});
```

If the daemon client today has no formal "disconnected" state machine (it only does request-level retries), this ticket needs scoping — see ticket 2 for details.

### Change 3 — Prewarm race fixes

Two targeted fixes in `prewarm-manager.ts`:

**3a.** Don't set `commandInjected = true` until `writeAfterReady` resolves AND the manager hasn't been disposed in the interim:

```ts
if (this.currentAgentCommand) {
  const cmdAtIssue = this.currentAgentCommand;
  const paneAtIssue = paneId;
  try {
    await this.client.writeAfterReady(paneId, cmdAtIssue + "\n");
    if (this.prewarmPaneId === paneAtIssue) {
      this.commandInjected = true;
    }
  } catch {
    if (this.prewarmPaneId === paneAtIssue) {
      this.commandInjected = false;
    }
  }
}
```

After this, `dispose()` racing with `writeAfterReady` resolution leaves `commandInjected` correctly false — the user gets a fresh empty session on next consume.

**3b.** Serialize `dispose` + `warm` so `updateCwd` cannot interleave a new warm with a stale dispose. Either:
- An internal mutex (`p-limit(1)` or a hand-rolled queued promise chain).
- Or bump a version number per `warm()` and short-circuit any post-dispose work that doesn't match the current version.

The version-number approach is simpler and matches existing code style (`warmingPaneId` already plays this role for the create step). Extend it to writeAfterReady:

```ts
private warmGeneration = 0;

async warm(cwd?: string, agentCommand?: string | null): Promise<void> {
  // ...
  const gen = ++this.warmGeneration;
  // ...
  if (this.warmGeneration !== gen) {
    // Superseded by a later warm() — abandon this in-flight work.
    this.client.kill(paneId).catch(() => {});
    return;
  }
  // ... continue with this.prewarmPaneId = paneId ...
}
```

Each await within `warm()` gets a `if (this.warmGeneration !== gen) return;` check.

## Consequences

**Better:**
- `paneContextMap` no longer leaks (Change 1).
- Daemon restarts no longer leave a stale prewarm (Change 2).
- `commandInjected` cannot lie about an aborted writeAfterReady (Change 3a).
- `updateCwd` cannot interleave a fresh warm into a stale dispose (Change 3b).

**Tradeoffs:**
- Change 1 adds one IPC and a defensive cleanup. Minor surface increase, well worth the leak fix.
- Change 2 requires plumbing a reconnect event through `TerminalHostClient`. If the existing client doesn't formalize disconnect (which I'd need to verify), this becomes a multi-file change. Worst case: the change is deferred to a follow-up ADR and we ship Changes 1 + 3 first.
- Change 3b's generation-counter pattern is one more piece of state to reason about. The alternative (a real mutex) imports a dependency or a small home-rolled lock. Generation counter is least invasive given existing code.

**Risks:**
- Change 2 silently no-ops if `client.onReconnect` is never called. Need to confirm the client actually has a reconnect path; if not, this ticket grows.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
