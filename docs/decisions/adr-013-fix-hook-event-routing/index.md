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

# ADR-013: Fix Hook Event Routing — Unify Agent Status Through Daemon

## Context

ADR-012 built out a comprehensive agent status detection system with hooks, fallbacks, and a state machine (`AgentDetector`). However, there is a critical architectural bug: **hook events bypass the AgentDetector entirely**.

### The bug

`AgentHookServer` (in the Electron main process) receives hook events via HTTP and sends them **directly to the renderer** via `mainWindow.webContents.send()`. The daemon's `AgentDetector` state machine — which manages `hasBeenActive`, hook debounce, the complete→idle timer, and fallback priority — never sees hook events.

This creates two unsynchronized status streams reaching the renderer:

1. **Hook server → renderer** (direct IPC, no state machine)
2. **Daemon → AgentDetector → session broadcast → client → renderer** (fallback/process detection, full state machine)

### Symptoms

- **No complete→idle transition for hook-driven completions.** The `AgentDetector.transitionToComplete()` method schedules a 3-second timer to clear back to idle. Since hooks bypass the detector, the renderer gets `"complete"` from the hook server but never gets the follow-up `"idle"` — the pane stays stuck in `"complete"`.
- **Fallback debounce doesn't work.** `lastHookTime` is never set, so fallback signals (output patterns, title changes) can immediately override hook-driven status instead of being suppressed for the 2-second debounce window.
- **`hasBeenActive` never set by hooks.** The detector doesn't know the agent was ever active, so if process exit detection fires, it may skip the complete transition.
- **Race conditions.** The daemon may send a fallback-driven status that conflicts with and overwrites a hook-driven status in the renderer.

### How agent-deck avoids this

Agent-deck routes ALL signals through a single `StateTracker` — hook events write to a status file, which is picked up by a `StatusFileWatcher`, and merged with terminal/title/activity signals in one unified pipeline. There is exactly one source of truth.

## Decision

Route hook events through the daemon's `AgentDetector` instead of sending directly to the renderer. The `AgentDetector` becomes the single source of truth for agent status.

### Data flow (before)

```
Hook event → AgentHookServer (main process) → IPC directly to renderer
                                               ← conflicts with ←
Fallback   → AgentDetector (daemon) → Session broadcast → client → main process → IPC to renderer
```

### Data flow (after)

```
Hook event → AgentHookServer (main process) → TerminalHostClient.relayAgentHook()
                                             → daemon stream socket
                                             → Session.setAgentHookStatus()
                                             → AgentDetector.setStatus()
                                             → onStatusChange callback
                                             → Session.broadcastEvent()
                                             → client → main process → IPC to renderer

Fallback   → (same daemon path, already correct)
```

### Changes required

**1. Add `agentHook` stream command** (`types.ts`)

Add to `StreamCommand` union:
```typescript
| { type: "agentHook"; sessionId: string; status: AgentStatus }
```

**2. Add `setAgentHookStatus()` to Session** (`session.ts`)

Public method that calls `this.agentDetector.setStatus(status)`. This is the entry point for hook events into the daemon.

**3. Add `setAgentHookStatus()` to TerminalHost** (`terminal-host.ts`)

Delegates to the session by ID.

**4. Handle `agentHook` in daemon stream handler** (`index.ts`)

In `handleStreamMessage`, add case for `"agentHook"` that calls `host.setAgentHookStatus()`.

**5. Add `relayAgentHook()` to TerminalHostClient** (`client.ts`)

Fire-and-forget method that writes the `agentHook` command to the stream socket.

**6. Change AgentHookServer to relay through client** (`agent-hooks.ts`)

Instead of `sendToRenderer()`, call `client.relayAgentHook(paneId, status)`. Remove the direct `mainWindow.webContents.send()` path entirely.

### What stays the same

- The hook script, hook registration, HTTP server, and event-to-status mapping are all unchanged.
- The `AgentDetector` state machine is unchanged — it already handles `setStatus()` correctly with all the guards (hasBeenActive, debounce, timers).
- Fallback detection pipeline is unchanged.
- Store and renderer logic is unchanged.

## Consequences

**Better:**
- Single source of truth for agent status (the `AgentDetector` in the daemon)
- Complete→idle timer works for hook-driven completions
- Fallback debounce works correctly (hooks update `lastHookTime`)
- `hasBeenActive` is set by hooks, so process-exit detection works correctly
- No more race conditions between two status streams

**Harder:**
- Hook events have slightly higher latency (extra hop through daemon socket vs direct IPC) — but this is sub-millisecond on localhost Unix socket, negligible.

**Risks:**
- If the daemon socket is temporarily disconnected, hook events are lost. Mitigated by the existing fallback detection pipeline — it was designed for exactly this scenario.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
