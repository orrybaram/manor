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

# ADR-012: Bulletproof Agent Status Detection

## Context

Agent status detection is THE core feature of Manor. Every agent running in the app must be tracked and correctly updated at all times. There is no acceptable failure mode.

### Current architecture (what exists)

Two detection tracks:

1. **Hook-based** (`AgentHookServer`): HTTP server receives 5 hook events (UserPromptSubmit, Stop, PostToolUse, PostToolUseFailure, PermissionRequest) and maps them to `running` or `waiting`.
2. **Process polling** (`AgentDetector` + `pty-subprocess`): 500ms polling via node-pty `proc_pidinfo` detects when agent binary becomes foreground process.

### What's broken

**Wrong status model.** Current: `idle | running | waiting | complete | error`.
- "running" conflates *thinking* (model generating) with *working* (tool executing) — the user can't tell what the agent is doing.
- "waiting" conflates *finished turn* (`Stop`) with *needs permission* (`PermissionRequest`) — completely different user actions required.
- `Stop` → "waiting" is wrong. Stop means the agent finished. It should be "complete", not "waiting".

**Only 5 of 22 available hook events.** Missing critical ones:
- `PreToolUse` — the ONLY way to distinguish thinking vs working (fires after model decides to call a tool, before execution)
- `Notification` (matcher: `permission_prompt`) — true "requires input" signal
- `SubagentStart` / `SubagentStop` — without these, subagents are invisible
- `StopFailure` — API errors, rate limits, billing errors go undetected
- `SessionStart` / `SessionEnd` — no lifecycle boundaries

**Zero fallback detection.** If hooks fail (crash, timeout, misconfigured), Manor is blind. agent-deck has 5 fallback strategies; Manor has 0:
- No pane title parsing (Claude Code sets braille spinners when working, done markers when finished)
- No terminal content parsing ("ctrl+c to interrupt" = busy, "Yes, allow once" = permission)
- No activity-based detection
- No stale process safety net (cmux does `kill(pid, 0)` every 30s)

**Zero tests.** The pipeline spans 5 files, 2 process boundaries, 2 IPC layers. Any regression silently breaks the UX.

### What agent-deck, cmux, and Superset do

- **agent-deck**: Priority pipeline (hooks → title → content → activity → hash), 29+ unit tests, lifecycle integration tests, per-tool pattern matching, false-positive filters
- **cmux**: Hook injection for 6 events, PID-based stale process sweeping every 30s, OSC sequence fallback for non-Claude agents
- **Superset/Mastra**: Event-driven display state reducer, typed event union, tested via event replay

## Decision

### New status model

Replace the current 5-state model with one that matches the user's mental model:

```typescript
type AgentStatus =
  | "idle"            // No agent active, or agent at prompt with no activity
  | "thinking"        // Agent is generating/reasoning (between UserPromptSubmit and first tool or Stop)
  | "working"         // Agent is executing a tool (between PreToolUse and PostToolUse)
  | "complete"        // Agent finished its turn (Stop fired) — auto-clears to idle after 3s
  | "requires_input"  // Agent needs user action (permission prompt, question, elicitation)
  | "error";          // Agent errored (StopFailure, rate limit, etc.)
```

### New hook event mapping

Subscribe to 11 hook events (up from 5):

| Hook Event | → Status | Notes |
|---|---|---|
| `UserPromptSubmit` | `thinking` | User submitted prompt, agent is reasoning |
| `PreToolUse` | `working` | Agent decided to use a tool |
| `PostToolUse` | `thinking` | Tool finished, agent reasoning about result |
| `PostToolUseFailure` | `thinking` | Tool failed, agent reasoning about error |
| `PermissionRequest` | `requires_input` | Permission dialog shown |
| `Notification` (permission_prompt) | `requires_input` | Notification-style permission |
| `Stop` | `complete` | Agent finished its turn |
| `StopFailure` | `error` | API error, rate limit, etc. |
| `SubagentStart` | `working` | Subagent spawned (track as nested activity) |
| `SubagentStop` | `thinking` | Subagent finished, parent resumes |
| `SessionEnd` | `idle` | Session terminated |

### Fallback detection pipeline (when hooks fail)

Three fallback strategies, checked in priority order:

**Fallback 1: Terminal output pattern matching.**
Parse the terminal output stream for known indicators:
- **Busy**: "ctrl+c to interrupt", "esc to interrupt", braille spinner characters (U+2800–U+28FF)
- **Requires input**: "Yes, allow once", "No, and tell Claude", "Do you trust", "(Y/n)", "Continue?"
- **Idle/prompt**: `❯` or `>` alone on last line after ANSI stripping

This runs on every DATA frame in the Session, feeding patterns to the AgentDetector as a secondary signal source. Hook events always take priority.

**Fallback 2: Pane title detection.**
Claude Code sets terminal titles via OSC escape sequences. Braille characters in the title = working. Done markers (✳✻✽✶✢) = complete. We already parse OSC 7 for CWD; extend to parse OSC 0/2 for title.

**Fallback 3: Stale process safety net.**
Every 30s, check if tracked agent PIDs are still alive via `kill(pid, 0)`. If ESRCH (process doesn't exist), force-clear to idle. Handles crashes where no Stop/SessionEnd hook fires.

### Architecture changes

```
Hook Events (primary, real-time)
  AgentHookServer receives HTTP POST
    → maps to new 6-state status
    → sends to AgentDetector via IPC

Terminal Output (fallback, pattern-based)
  Session.handleSubprocessFrame(DATA)
    → OutputPatternMatcher scans for indicators
    → feeds secondary signals to AgentDetector

Pane Title (fallback, cheap)
  Session.parseOscTitle(data)
    → TitleDetector checks braille/done markers
    → feeds to AgentDetector

Process Polling (existing, 500ms)
  pty-subprocess polls foreground process
    → AgentDetector tracks agent lifecycle

Stale PID Sweep (safety net, 30s)
  AgentDetector.sweepStalePids()
    → force-clears dead agents to idle

AgentDetector (state machine)
  Receives signals from ALL sources
  Hook events take priority over fallbacks
  Emits status changes → Session broadcasts → IPC → Store → UI
```

### Files to create/modify

**New files:**
- `electron/terminal-host/output-pattern-matcher.ts` — terminal output pattern matching
- `electron/terminal-host/title-detector.ts` — OSC title analysis
- `electron/terminal-host/__tests__/agent-detector.test.ts` — AgentDetector unit tests
- `electron/terminal-host/__tests__/output-pattern-matcher.test.ts` — pattern matching tests
- `electron/terminal-host/__tests__/title-detector.test.ts` — title detection tests
- `electron/terminal-host/__tests__/agent-lifecycle.test.ts` — E2E scenario tests
- `electron/__tests__/agent-hooks.test.ts` — hook server tests
- `src/store/__tests__/agent-status-store.test.ts` — store tests

**Modified files:**
- `electron/terminal-host/types.ts` — new AgentStatus type
- `electron/terminal-host/agent-detector.ts` — new state machine with signal priority
- `electron/agent-hooks.ts` — subscribe to 11 events, new mapping
- `electron/terminal-host/session.ts` — wire in output parser, title detector
- `src/electron.d.ts` — update AgentStatus/AgentState types
- `src/store/app-store.ts` — update store for new statuses
- `src/components/AgentDot.tsx` — new visual states (thinking vs working vs requires_input)
- `src/components/AgentDot.module.css` — new animations/colors
- `src/components/useSessionAgentStatus.ts` — updated priority map

## Consequences

**Better:**
- Users can distinguish thinking (model generating) from working (tool running) from requires_input (permission needed)
- Every agent including subagents is tracked
- System degrades gracefully: hooks → output patterns → title → process polling → PID sweep
- Comprehensive tests mean regressions are caught immediately
- Tests serve as living specification of expected behavior

**Harder:**
- More complex state machine with more inputs
- Pattern matching needs maintenance as Claude Code UI evolves
- 11 hook registrations instead of 5

**Risks:**
- Terminal output patterns are fragile (Claude Code updates could change output format)
- Hook priority over fallbacks must be carefully managed to avoid flicker
- Must avoid false positives from pattern matching when hooks are working correctly

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
