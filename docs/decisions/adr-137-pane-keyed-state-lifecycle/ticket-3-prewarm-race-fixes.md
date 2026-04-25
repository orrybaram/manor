---
title: Fix PrewarmManager updateCwd race + commandInjected lie
status: todo
priority: medium
assignee: sonnet
blocked_by: []
---

# Fix PrewarmManager updateCwd race + commandInjected lie

Two related races in `electron/prewarm-manager.ts`:

1. `updateCwd` does `dispose()` then `warm()` (lines 100-101). An in-flight `warm()` from before can still complete `client.createNoSubscribe` and call `writeAfterReady` against a paneId that the new dispose already killed; `commandInjected = true` lands on a dead session, and the next `consume()` lies.
2. `dispose()` clears `warmingPaneId` immediately (line 108), then issues an `await this.client.kill(toKill)` (line 115). The check at line 43 (`if (this.warmingPaneId !== paneId)`) catches the post-create case but not the post-writeAfterReady case.

See ADR-137 §"Change 3" for full reasoning.

## What to change

### A. Generation counter

Add a `warmGeneration` counter that increments each `warm()` call. Each await checkpoint inside `warm()` short-circuits if `warmGeneration` has advanced:

```ts
private warmGeneration = 0;

async warm(cwd?: string, agentCommand?: string | null): Promise<void> {
  if (cwd) this.currentCwd = cwd;
  if (agentCommand !== undefined) this.currentAgentCommand = agentCommand;
  if (this.state === "warming") return;

  const gen = ++this.warmGeneration;
  this.state = "warming";
  this.commandInjected = false;
  const paneId = `pane-${crypto.randomUUID()}`;
  this.warmingPaneId = paneId;

  try {
    await this.client.createNoSubscribe(paneId, this.currentCwd, this.defaultCols, this.defaultRows, true);
    if (this.warmGeneration !== gen) {
      this.client.kill(paneId).catch(() => {});
      return;
    }

    this.prewarmPaneId = paneId;
    this.warmingPaneId = null;
    this.state = "ready";

    if (this.currentAgentCommand) {
      const cmdAtIssue = this.currentAgentCommand;
      try {
        await this.client.writeAfterReady(paneId, cmdAtIssue + "\n");
        if (this.warmGeneration === gen && this.prewarmPaneId === paneId) {
          this.commandInjected = true;
        }
      } catch {
        if (this.warmGeneration === gen && this.prewarmPaneId === paneId) {
          this.commandInjected = false;
        }
      }
    }
  } catch (err) {
    if (this.warmGeneration === gen) {
      console.error("[PrewarmManager] Failed to warm session:", err);
      this.state = "idle";
      this.prewarmPaneId = null;
      this.warmingPaneId = null;
      this.commandInjected = false;
    }
  }
}
```

`dispose()` and `reset()` should also bump the counter so any in-flight `warm()` work is invalidated:

```ts
async dispose(): Promise<void> {
  this.warmGeneration++;          // invalidate any in-flight warm
  // ... existing logic ...
}

reset(): void {
  this.warmGeneration++;          // invalidate any in-flight warm
  // ... existing logic ...
}
```

### B. Don't drop the `warming` early-return

Today `if (this.state === "warming") return;` (line 26) means a second `warm()` while the first is in flight is a no-op. With the generation counter, callers can rely on "warm() always means warm-with-current-cwd" — `updateCwd` already calls dispose-then-warm, so the early return only fires under racy callers. Keep it for now; revisit if a use case emerges.

## Files to touch

- `electron/prewarm-manager.ts` — add `warmGeneration`, gate each await on it; bump in `dispose()` and `reset()`.

## Tests

`electron/__tests__/prewarm-manager.test.ts` (new or extend existing):

1. **Late-write race.** Mock `client.createNoSubscribe` to resolve immediately, mock `writeAfterReady` to resolve after a 50 ms delay. Call `warm("/a", "cmd1")`, then 10 ms later call `warm("/b", "cmd2")` (or call `dispose()` then `warm("/b", "cmd2")` — pick the path that exercises the race). After the first `writeAfterReady` resolves, the manager's state must reflect `/b` only; the first warm's `commandInjected` flag must NOT have stuck.
2. **Late-create race.** Same pattern, this time delay `createNoSubscribe`. After both warms settle, only the second's paneId should be in `prewarmPaneId`; the first's pane should have been killed.
3. **Reset during warm.** Start a warm, call `reset()` mid-flight, await the original promise. State should be idle, no commandInjected leak.
