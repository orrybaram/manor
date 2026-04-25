---
title: PrewarmManager resets and re-warms on daemon reconnect
status: todo
priority: medium
assignee: opus
blocked_by: []
---

# PrewarmManager resets and re-warms on daemon reconnect

If the daemon process dies and restarts, the prewarmed paneId in `PrewarmManager` is stale: the daemon doesn't have a session by that id, but `PrewarmManager.state === "ready"`. Next `consume()` returns garbage; next IPC for that pane fails.

See ADR-137 §"Change 2" for full reasoning.

## What to change

### A. Audit `TerminalHostClient` for an existing reconnect path

Before writing new plumbing, read `electron/terminal-host/client.ts` and identify how a daemon-died-and-respawned scenario is detected today. Possibilities:
- A connection-monitoring loop that re-issues `handshake` and notices the socket dropped.
- Per-request retry that transparently respawns the daemon.
- Nothing — daemon death is a fatal client error.

If there is an existing reconnect, hook into it. If there isn't, the ADR scope grows; surface that finding back in this ticket and either expand or carve off into a follow-up.

### B. Expose reconnect events on the client

Assuming the client has a reconnect path, add a public listener API:

```ts
// electron/terminal-host/client.ts
private reconnectListeners: Array<() => void> = [];

onReconnect(cb: () => void): () => void {
  this.reconnectListeners.push(cb);
  return () => {
    const i = this.reconnectListeners.indexOf(cb);
    if (i >= 0) this.reconnectListeners.splice(i, 1);
  };
}

private fireReconnect(): void {
  for (const cb of this.reconnectListeners) {
    try { cb(); } catch (err) { console.error("[client] reconnect listener error:", err); }
  }
}
```

Call `fireReconnect()` from the existing reconnect-success site.

### C. Wire PrewarmManager to it

In `electron/app-lifecycle.ts`, after `prewarmManager` is constructed:

```ts
client.onReconnect(() => {
  console.debug("[app] daemon reconnected; resetting prewarm");
  prewarmManager.reset();
  prewarmManager.warm().catch(() => {});
});
```

`reset()` is already defined at `prewarm-manager.ts:123-128` for exactly this use case.

## Files to touch

- `electron/terminal-host/client.ts` — add `onReconnect` listener API; call `fireReconnect` from existing reconnect site.
- `electron/app-lifecycle.ts` — register the prewarm reset/warm callback.

## Tests

- Unit on client: register a listener, simulate a reconnect, listener fires.
- Integration smoke: kill the daemon manually (or via test harness), confirm next `consume()` returns a working pane.

## Notes

Opus-assigned because step A (the audit) is open-ended. If it turns out the client has no formal reconnect lifecycle, the ticket scope expands to "add one" — at which point flag for re-scoping rather than silently doing it. Don't extend client behaviour beyond what's necessary for prewarm.
