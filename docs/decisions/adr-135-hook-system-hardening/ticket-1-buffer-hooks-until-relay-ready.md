---
title: Buffer hook events until relay is wired
status: done
priority: critical
assignee: sonnet
blocked_by: []
---

# Buffer hook events until relay is wired

`AgentHookServer` accepts HTTP connections from the moment `start()` resolves, but `setRelay` is not called until later in `app-lifecycle.ts:357`. Events that arrive in the gap (e.g. fast `claude --resume` of a finished session) hit `this.relayFn?.(...)` at `agent-hooks.ts:114` — `relayFn` is null, so they're silently null-coalesced and lost.

See ADR-135 §"Change 1" for full reasoning.

## What to change

In `electron/agent-hooks.ts`, add a bounded pending-events queue and replay it when `setRelay` is first called.

```ts
type RelayArgs = [
  paneId: string,
  status: AgentStatus,
  kind: AgentKind,
  sessionId: string | null,
  eventType: string,
  toolUseId: string | null,
];

export class AgentHookServer {
  private relayFn: ((...args: RelayArgs) => void) | null = null;
  private pending: RelayArgs[] = [];
  private static readonly MAX_PENDING = 1000;

  setRelay(relay: (...args: RelayArgs) => void): void {
    this.relayFn = relay;
    const queued = this.pending;
    this.pending = [];
    for (const args of queued) {
      try {
        relay(...args);
      } catch (err) {
        console.error("[agent-hooks] error replaying queued event:", err);
      }
    }
  }

  // In the request handler, replace `this.relayFn?.(...)` with:
  if (status) {
    if (this.relayFn) {
      this.relayFn(paneId, status, kind, sessionId, eventType, toolUseId);
    } else if (this.pending.length < AgentHookServer.MAX_PENDING) {
      this.pending.push([paneId, status, kind, sessionId, eventType, toolUseId]);
    } else {
      console.warn(
        `[agent-hooks] dropping hook event (queue full): paneId=${paneId} event=${eventType}`,
      );
    }
  }
}
```

Replay must preserve order. The cap (1000) is a sanity bound — under normal boot we expect ≤ a handful of queued events.

## Files to touch

- `electron/agent-hooks.ts` — add `pending`, `MAX_PENDING`, replay loop in `setRelay`, queueing branch in the request handler.

## Tests

Add a unit test in `electron/__tests__/` (new or existing agent-hooks suite):

1. Construct `AgentHookServer`, `start()` it, send three HTTP requests before `setRelay` — relay receives nothing yet.
2. Call `setRelay(spy)`. Spy receives all three calls in order.
3. Subsequent requests post-`setRelay` go straight through (no queueing).
4. Saturate the queue past `MAX_PENDING`; assert oldest events were retained and overflow events were dropped (current proposal: drop newest; verify against the implementation choice).
