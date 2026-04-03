---
title: Wire input detection in Session and update store to keep idle agents
status: done
priority: critical
assignee: sonnet
blocked_by: [1]
---

# Wire input detection in Session and update store to keep idle agents

Connect the terminal input path to the AgentDetector so typing clears `complete`, and update the store so `idle` agents aren't removed.

## Implementation

### 1. Add input detection in `Session.write()` (`session.ts`)

Before forwarding input to the subprocess, check if the agent is in `complete` state and notify the detector:

```typescript
write(data: string): void {
  if (!this._alive || !this.subprocess) return;
  // User input while agent completed → back to idle (agent still present)
  if (this.agentDetector.getState().status === "complete") {
    this.agentDetector.setInputReceived();
  }
  this.writeToSubprocess(encodeFrame(MSG.WRITE, data));
}
```

### 2. Update `setPaneAgentStatus` in store (`app-store.ts`)

Remove the special case that deletes the entry when status is `idle`. The agent should remain in the store as long as it's present in the pane:

**Before:**
```typescript
if (agent.status === "idle") {
  const { [paneId]: _, ...rest } = state.paneAgentStatus;
  return { paneAgentStatus: rest };
}
return { paneAgentStatus: { ...state.paneAgentStatus, [paneId]: agent } };
```

**After:**
```typescript
return { paneAgentStatus: { ...state.paneAgentStatus, [paneId]: agent } };
```

Agent entries are already cleaned up when panes are closed (in `closePane` and `removeWorkspace`). The `transitionToGone()` in the detector will emit an idle event with `kind: null` — use this to remove from the store instead:

```typescript
// Remove from store only when agent is truly gone (kind is null and status is idle)
if (agent.status === "idle" && agent.kind === null) {
  const { [paneId]: _, ...rest } = state.paneAgentStatus;
  return { paneAgentStatus: rest };
}
return { paneAgentStatus: { ...state.paneAgentStatus, [paneId]: agent } };
```

This distinguishes between:
- `idle` with `kind: "claude"` → agent present, keep in store (dim indicator)
- `idle` with `kind: null` → agent gone, remove from store (no indicator)

### 3. Fix persistence restore filter (`app-store.ts`)

The layout restore currently skips idle agents. Update the filter to keep idle agents that have a kind:

**Before (around line 183):**
```typescript
if (paneSession.lastAgentStatus && paneSession.lastAgentStatus.status !== "idle") {
  agents[paneId] = paneSession.lastAgentStatus as AgentState;
}
```

**After:**
```typescript
if (paneSession.lastAgentStatus &&
    !(paneSession.lastAgentStatus.status === "idle" && paneSession.lastAgentStatus.kind === null)) {
  agents[paneId] = paneSession.lastAgentStatus as AgentState;
}
```

This restores idle agents with a kind (agent still running) but skips "gone" agents (kind=null, status=idle).

## Files to touch
- `electron/terminal-host/session.ts` — add input detection in `write()`
- `src/store/app-store.ts` — update `setPaneAgentStatus` to keep idle agents with kind, fix restore filter
