---
title: Add agentHook stream command and daemon wiring
status: done
priority: critical
assignee: sonnet
blocked_by: []
---

# Add agentHook stream command and daemon wiring

Wire up the daemon side so it can receive hook events via the stream socket and route them into the existing `AgentDetector.setStatus()` method.

## Implementation

### 1. Add `agentHook` to StreamCommand union (`electron/terminal-host/types.ts`)

Add to the `StreamCommand` type union:

```typescript
| { type: "agentHook"; sessionId: string; status: AgentStatus }
```

### 2. Add `setAgentHookStatus()` to Session (`electron/terminal-host/session.ts`)

Add a public method:

```typescript
/** Called when a hook event arrives for this session */
setAgentHookStatus(status: AgentStatus): void {
  this.agentDetector.setStatus(status);
}
```

This is intentionally thin — the `AgentDetector.setStatus()` already handles all the state machine logic (hasBeenActive, debounce, timers, deduplication).

### 3. Add `setAgentHookStatus()` to TerminalHost (`electron/terminal-host/terminal-host.ts`)

Add a method that looks up the session and delegates:

```typescript
/** Relay a hook-driven agent status to a session's detector */
setAgentHookStatus(sessionId: string, status: AgentStatus): void {
  this.sessions.get(sessionId)?.setAgentHookStatus(status);
}
```

Import `AgentStatus` from `./types`.

### 4. Handle `agentHook` in daemon stream handler (`electron/terminal-host/index.ts`)

In the `handleStreamMessage` function, add a case:

```typescript
case "agentHook":
  host.setAgentHookStatus(command.sessionId, command.status);
  break;
```

## Files to touch
- `electron/terminal-host/types.ts` — add `agentHook` to StreamCommand union
- `electron/terminal-host/session.ts` — add `setAgentHookStatus()` method
- `electron/terminal-host/terminal-host.ts` — add `setAgentHookStatus()` delegation method
- `electron/terminal-host/index.ts` — handle `agentHook` in stream message handler
