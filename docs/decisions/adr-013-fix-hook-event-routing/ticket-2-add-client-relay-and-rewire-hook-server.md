---
title: Add client relay method and rewire AgentHookServer
status: done
priority: critical
assignee: sonnet
blocked_by: [1]
---

# Add client relay method and rewire AgentHookServer

Add a relay method to `TerminalHostClient` and change `AgentHookServer` to route through the daemon instead of sending directly to the renderer.

## Implementation

### 1. Add `relayAgentHook()` to TerminalHostClient (`electron/terminal-host/client.ts`)

Add a fire-and-forget method that sends the agentHook command via the stream socket:

```typescript
/** Relay an agent hook event to the daemon (fire-and-forget) */
relayAgentHook(sessionId: string, status: AgentStatus): void {
  this.streamWrite({ type: "agentHook", sessionId, status });
}
```

Import `AgentStatus` from `./types`.

### 2. Rewire AgentHookServer (`electron/agent-hooks.ts`)

**Remove** the `mainWindow` dependency from `AgentHookServer`. Instead, accept a callback or the client directly.

Change the class to accept a relay function:

```typescript
export class AgentHookServer {
  private server: http.Server | null = null;
  private port = 0;
  private relayFn: ((paneId: string, status: AgentStatus) => void) | null = null;

  async start(relay: (paneId: string, status: AgentStatus) => void): Promise<void> {
    this.relayFn = relay;
    // ... rest of server setup unchanged ...
  }
}
```

In the HTTP handler, replace `this.sendToRenderer(paneId, status)` with `this.relayFn?.(paneId, status)`.

**Delete** the `sendToRenderer()` method entirely — it is no longer needed.

### 3. Update main.ts wiring (`electron/main.ts`)

Change the `agentHookServer.start()` call to pass a relay function that calls the client:

```typescript
await agentHookServer.start((paneId, status) => {
  client.relayAgentHook(paneId, status);
});
```

Remove the `mainWindow` argument from the `start()` call. The hook server no longer needs a reference to the window.

## Files to touch
- `electron/terminal-host/client.ts` — add `relayAgentHook()` method
- `electron/agent-hooks.ts` — remove `mainWindow`/`sendToRenderer`, accept relay callback instead
- `electron/main.ts` — update `agentHookServer.start()` call to pass relay function
