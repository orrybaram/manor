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

# ADR-014: Agent Status Lifecycle — Persistent Tracking

## Context

After ADR-012 (agent status detection) and ADR-013 (hook routing fix), the detection pipeline works: hooks fire, events reach the AgentDetector, and the correct statuses are emitted. However, the **lifecycle model** is wrong.

### Current behavior (broken)

1. **`complete` auto-clears to `idle` after 3 seconds** via `scheduleIdleAfterComplete()`. The user sees a brief flash of "done" then it vanishes.
2. **`idle` removes the agent from the store** — `setPaneAgentStatus` deletes the entry when status is `idle`. The agent dot disappears entirely.
3. **`transitionToIdle()` clears kind/processName/title** — the detector forgets the agent exists, even though Claude Code is still running in the pane.

The result: after Claude finishes a turn, the agent indicator vanishes within 3 seconds. The user has no persistent indication that Claude Code is running in the pane, what it last did, or that it's ready for the next prompt.

### Desired behavior

The agent indicator should be visible the **entire time Claude Code is running** in a pane, with different intensities per state:

```
Claude starts  → idle (dim indicator — agent present, awaiting first prompt)
User submits   → thinking (prominent — model reasoning)
Tool call      → working (prominent — executing tool)
Permission     → requires_input (prominent — needs user action)
Turn finishes  → complete (visible — persists until next turn or exit)
User submits   → thinking (title cleared for new turn) ...
User /clear    → thinking (title cleared for new thread) ...
User exits CC  → agent removed (indicator gone)
```

**Key rules:**
- `complete` stays visible indefinitely — user typing does NOT clear it
- `idle` does NOT remove the agent from tracking — it just dims the indicator
- Agent is only removed on: process exit (shell returns), pane close, or SessionEnd hook
- When a new turn starts (`thinking` hook fires), the title is cleared so the new task's title can be set via OSC sequences

## Decision

### 1. Remove the complete→idle auto-clear timer

Delete `COMPLETE_CLEAR_MS`, `scheduleIdleAfterComplete()`, and all calls to it. `complete` is now a stable state that persists until an external event changes it.

The `completeClearTimer` field and `clearTimers()` method can be removed entirely.

### 2. Split idle into two concepts: "idle" (agent present) vs "gone" (agent removed)

Currently `transitionToIdle()` does double duty: it resets status to idle AND clears kind/processName/title (forgetting the agent). These need to be separated:

- **`transitionToIdle()`** — sets status to `idle` but KEEPS kind, processName, title. The agent is still present in the pane. Used when: user types after complete, UserPromptSubmit arrives (resets to thinking anyway).
- **`transitionToGone()`** (new) — clears everything: kind, processName, title, hasBeenActive, status to idle. The agent has actually exited. Used when: shell returns to foreground, SessionEnd hook, stale PID sweep finds dead process.

### 3. ~~Add terminal input detection for complete→idle~~ (REVISED: Remove input detection)

**Original decision:** Transition complete→idle when user types. **Revised:** `complete` now persists through user typing. The status only changes when:
- A new turn starts (hook fires `thinking`) — title is cleared for the new task
- The agent exits (process dies, session ends)

Remove `setInputReceived()` from `AgentDetector` and the input detection in `Session.write()`.

### 3a. Clear title on new turn

When `setStatus()` receives `thinking`, clear the title. This ensures each turn (and each new thread after `/clear`) gets a fresh title from the agent's OSC sequences rather than showing the previous task's title.

```typescript
// In setStatus(), when transitioning to thinking:
if (status === "thinking" || status === "working" || status === "requires_input") {
  this.hasBeenActive = true;
}
if (status === "thinking") {
  this.title = null; // Clear title for new turn
}
```

### 4. Stop removing idle agents from the store

In `setPaneAgentStatus` in `app-store.ts`, remove the special case that deletes the entry when status is `idle`:

```typescript
// Before:
if (agent.status === "idle") {
  const { [paneId]: _, ...rest } = state.paneAgentStatus;
  return { paneAgentStatus: rest };
}

// After: just store it like any other status
return { paneAgentStatus: { ...state.paneAgentStatus, [paneId]: agent } };
```

The entry is only removed when the pane is closed (existing cleanup in `closePane` / `removeWorkspace`).

### 5. Update process exit handling

In `updateForegroundProcess()`, when the agent exits (shell returns to foreground):
- If agent was active (thinking/working/requires_input) → `transitionToGone()` (not complete — the process died unexpectedly)
- If agent was complete → `transitionToGone()` (user exited Claude after it finished)
- If agent was idle → `transitionToGone()`

The key change: we no longer go through a "complete" intermediate state on process exit. If the process is gone, the agent is gone.

### 6. Fix persistence restore to keep idle agents

Agent status is already persisted to `~/.manor/layout.json` via the layout persistence system (`PersistedPaneSession.lastAgentStatus`). The save path is correct — it writes whatever is in `paneAgentStatus`. But the **restore path** in `app-store.ts` filters out idle agents:

```typescript
// Current (line 183):
if (paneSession.lastAgentStatus && paneSession.lastAgentStatus.status !== "idle") {
  agents[paneId] = paneSession.lastAgentStatus as AgentState;
}
```

This needs to match the new store behavior — restore idle agents that have a kind:

```typescript
if (paneSession.lastAgentStatus &&
    !(paneSession.lastAgentStatus.status === "idle" && paneSession.lastAgentStatus.kind === null)) {
  agents[paneId] = paneSession.lastAgentStatus as AgentState;
}
```

### Files to modify

- `electron/terminal-host/agent-detector.ts` — remove timer, split idle/gone, ~~add `setInputReceived()`~~ remove `setInputReceived()`, clear title on `thinking`
- `electron/terminal-host/session.ts` — ~~add input detection in `write()`~~ remove input detection from `write()`
- `src/store/app-store.ts` — stop removing idle agents from store, fix restore filter
- `electron/terminal-host/__tests__/agent-detector.test.ts` — update tests for new lifecycle
- `electron/terminal-host/__tests__/agent-full-pipeline.test.ts` — update pipeline tests
- `src/store/__tests__/agent-status-store.test.ts` — update store tests

## Consequences

**Better:**
- Agent indicator visible the entire time Claude Code is running — user always knows what's happening
- `complete` is a meaningful persistent state that persists until the next turn or exit
- Title refreshes naturally when a new turn starts (including after `/clear`)
- Clean separation between "agent is idle" and "agent is gone"

**Harder:**
- `idle` entries persist in the store, slightly more memory (negligible — one object per pane)
- Need to ensure `transitionToGone()` is called on all exit paths to prevent stale entries

**Risks:**
- If process exit detection fails AND no SessionEnd hook fires, an agent entry could persist after Claude exits. Mitigated by the existing stale PID sweep (30s interval) which will call `transitionToGone()`.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
