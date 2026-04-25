# AgentDetector Audit (ADR-138 ticket-4)

This audit categorizes every code branch in `electron/terminal-host/agent-detector.ts`
(395 lines) by its role given that **hook events drive `AgentStatus` authoritatively**
through `mapEventToStatus()` in `electron/agent-hooks.ts`.

It answers: *what does the detector still need to do, and what is now redundant?*

The audit was performed against:

- `electron/terminal-host/agent-detector.ts` (subject under audit)
- `electron/terminal-host/session.ts` (call sites — `setStatus`, `setFallbackStatus`,
  `updateForegroundProcess`, `setTitle`, `setAltScreen`, `sweepStalePids`)
- `electron/agent-hooks.ts` lines 23–46 (`mapEventToStatus`)
- `electron/hook-relay.ts` lines 419–436 (`notifyAgentDetectorGone` — the bridge)
- `electron/app-lifecycle.ts` lines 96–117 (the `kind=null && status=idle` trigger
  that fires the bridge)
- `electron/agent-connectors.ts` (which agents register hooks)
- `electron/terminal-host/pty-subprocess.ts` (FGPROC frame producer — provides
  the `name` argument to `updateForegroundProcess`, never the `pid`)

## Categories

- **Load-bearing** — the only path that produces this signal. Removal would
  silently break behaviour.
- **Hook-supplemented** — produces the same signal as a hook event, but is
  required for sessions that have no hooks (today: opencode users, or any agent
  the user runs without our hooks installed).
- **Hook-redundant** — the hook event arrives reliably for this case AND the
  detector path runs in addition. Candidate for future removal once we can
  verify hooks-only behaviour in practice.
- **Dead** — branch never fires under any current production wiring.

## Hook coverage by agent

| Agent kind | Hooks registered | requires_input via hook? | SessionEnd via hook? |
|------------|------------------|--------------------------|----------------------|
| claude     | All 11 events    | Yes (PermissionRequest, Notification matcher=permission_prompt) | Yes |
| codex      | 5 events: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop | **No**                  | **No**               |
| pi         | 8 events: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, Stop, StopFailure, SessionEnd | **No**                  | Yes                  |
| opencode   | None (no connector)                                                          | **No**                  | **No**               |

This table is the lens for everything below: anything that produces
`requires_input` heuristically is load-bearing for codex, pi, and opencode
users. Anything that produces `idle` heuristically is load-bearing for codex
and opencode.

## Branch-by-branch categorization

### 1. Module-level constants

| Lines | Construct | Category | Reasoning |
|-------|-----------|----------|-----------|
| 15–20 | `KNOWN_AGENTS` map (`claude`, `opencode`, `codex`, `pi`) | Load-bearing | The only source for `agentKind` derivation when only a process basename is known. opencode has no hooks, so it MUST be matched here. |
| 23 | `_GENERIC_TITLES` set | **Dead** | Defined with leading underscore, zero readers anywhere in the repo. |
| 25–33 | `KNOWN_SHELLS` set | Load-bearing | Used by `updateForegroundProcess` to distinguish "shell returned to foreground → agent gone" from "agent spawned a child process". |
| 35    | `HOOK_DEBOUNCE_MS = 2000` | Load-bearing | Prevents fallback signals from clobbering recent hook-driven status. |

### 2. `setTitle()` — lines 92–97

| Category | Reasoning |
|----------|-----------|
| Load-bearing | The OSC 0/2 title becomes `task.name` via `app-lifecycle.ts handleStreamEvent`. There is no hook-side equivalent that sends the human-readable task title (Claude Code emits the title via OSC 2; pi extension calls `ctx.ui.setTitle()`). The detector is the only path turning that into an `AgentState.title`. |

### 3. `updateForegroundProcess()` — lines 99–178

This is the biggest single method. It serves three jobs:

**3a. Setting `kind` from process name (lines 130–152)** — Load-bearing.

The relay receives `kind` *only* on `relayAgentHook(paneId, status, kind)` calls,
which require a hook to fire. For an opencode session (no hooks), this branch
is the **only** way `AgentState.kind` is ever set. Necessary for the agent dot
in the UI even on hookless sessions.

**3b. Process-gone detection (lines 108–127)** — Load-bearing (kill -9).

When `name` becomes `null` (PTY foreground process is back to the shell or
empty) and the agent was active, this transitions to `gone` (kind=null, status=idle).
That state combination is what `app-lifecycle.ts:112-116` watches for and uses
to fire `notifyAgentDetectorGone(paneId)`, the bridge to the relay.

This is the **only path** for kill -9 / agent-crash recovery. Hook-side
`SessionEnd` does not fire on a SIGKILLed agent; without this branch a crashed
agent leaves its task stuck "thinking".

The three sub-branches (active→gone, complete→gone, other→gone) collapse to
the same `transitionToGone()` call but log differently. They are all reachable
and load-bearing.

**3c. Shell-returns-to-foreground exit detection (lines 165–177)** —
Load-bearing for hookless agents; hook-supplemented for hooked agents.

When a known shell (zsh, bash, etc.) is observed in the foreground while the
agent had been active, we treat that as the agent exited. For claude/pi this
is hook-supplemented (SessionEnd usually arrives), but the cleanup is faster
via foreground polling. For codex this is load-bearing because codex has no
SessionEnd hook.

The "spawn a child" guard at lines 153–164 keeps an active agent tracked
when it shells out (e.g. agent runs `git`). Load-bearing — without it,
ordinary agent-spawned subprocesses would force the agent to `gone`.

The PID-tracking sub-block at lines 138–141 (`this.trackedPids.set(pid, …)`)
is **dead in production**. `pty-subprocess.ts:271` only sends the process
*name* via the `FGPROC` frame; `session.ts:335` calls
`this.agentDetector.updateForegroundProcess(name)` with no `pid`. No code path
in production ever provides a non-undefined PID. Testable only via
`updateForegroundProcess("claude", 12345)` calls in unit tests.

> **Recommendation (ambiguous, do NOT delete now):** the PID tracking +
> `sweepStalePids` machinery would be safe to remove, but only if a future
> change does not want to add real PID telemetry. Leaving it as a dormant
> capability is reasonable. Filed as a follow-up candidate, not deleted here.

### 4. `setStatus()` — lines 180–242 (hook-driven path)

| Sub-branch | Lines | Category | Reasoning |
|------------|-------|----------|-----------|
| Adopt `kind` from hook when none yet (`if (kind && !this.kind)`) | 188–192 | Load-bearing | Necessary when a hook arrives faster than the FGPROC poll (~500 ms cadence). Scenario 8 in `agent-lifecycle.test.ts` covers this race. |
| `status === "idle"` → `transitionToGone()` | 195–199 | Load-bearing | This is the SessionEnd-driven path that fires the bridge for hooked agents. Even though hook-relay handles SessionEnd directly, the detector also flips kind=null so the UI clears the agent dot. |
| Drop hook when `idle && !this.kind` | 201–208 | Load-bearing | Safe-guard for the race where a hook arrives before any process has been observed AND no `kind` is supplied. Without this, `setStatus("thinking")` with no kind would silently change `status` to thinking with `kind=null`, painting an "unknown agent" dot. |
| `hasBeenActive` tracking (true on thinking/working/requires_input) | 210–217 | Load-bearing | Gates the spurious-`complete` filter just below. |
| Drop `complete`/`error` when `!hasBeenActive` | 219–224 | Load-bearing | Filters the spurious early Stop hook that fires during Claude Code startup before any prompt has been submitted. Without this, the UI flashes a `complete` dot the moment the user opens Claude. |
| Clear title on `thinking` | 226–228 | Load-bearing | Title is per-turn; this prevents the previous turn's title from leaking. |
| `status === "complete"` → `transitionToComplete()` (with linger timer) | 232–234 | Load-bearing | The linger timer auto-cleans the agent dot 5 s after Stop, *before* the agent process exits. There is no hook-side equivalent. |
| Update tracked PID statuses | 238–241 | Hook-redundant + dormant | Mirrors the dead PID-tracking machinery from §3c. No production caller sets a PID, so the loop is over an empty map. Safe to remove with §3c. |

### 5. `setFallbackStatus()` — lines 244–278

| Category | Reasoning |
|----------|-----------|
| **Load-bearing for codex, pi, opencode; hook-supplemented for claude.** | Producers (`session.ts:288–299`) feed two signals: title-derived status (braille = working, ✳/✻ marker = complete) and output-pattern matches (e.g. "Yes, allow once" → `requires_input`, `(Y/n)` → `requires_input`, `❯` prompt → `idle`). For codex this is the *only* source of `requires_input` because codex has no PermissionRequest hook. For opencode it is the only status signal at all. The 2 s hook debounce keeps it from clobbering authoritative hook updates on claude. |

The `if (!this.kind)` guard at 250–254 is load-bearing: it prevents
unrelated terminal output (e.g. a user typing `Yes, allow once` in a plain shell)
from creating a fake agent dot.

### 6. `sweepStalePids()` — lines 280–325

| Category | Reasoning |
|----------|-----------|
| **Dead in production.** | Only fires when `trackedPids` is non-empty. `trackedPids` is populated only by `updateForegroundProcess(name, pid)` with a non-undefined PID. The single production caller (`session.ts:335`) never passes a PID. The 30-second `pidSweepTimer` in `session.ts:163-165` runs forever over an empty map. |

> **Recommendation (ambiguous, do NOT delete now):** Equivalent kill-9 coverage
> already exists via `updateForegroundProcess(null) → transitionToGone`, which
> *is* wired up. Removing PID tracking + the sweep would simplify the detector,
> but it touches `session.ts` (the timer) and several tests. Better as its own
> follow-up after a deliberate decision about whether to wire real PID
> telemetry through the FGPROC frame.

### 7. `processOutput()` — lines 327–330

| Category | Reasoning |
|----------|-----------|
| **Dead.** | Method body is a comment-only no-op. Zero production callers — `session.ts` does not call `processOutput` from the `MSG.DATA` handler. The only callers are the two assertions in `agent-detector.test.ts:350-353` that verify it remains a no-op. |

> **Recommendation: delete in this PR.** No production caller; the test only
> exists to assert the no-op. Both go.

### 8. `setAltScreen()` — lines 332–335

| Category | Reasoning |
|----------|-----------|
| Hook-redundant (effectively dead body, live call site). | Method body is a no-op. Production callers exist (`session.ts:547, 551`) when the terminal enters/leaves alt screen via CSI ?1049h/l. The comment says "Kept for API compatibility". |

> **Recommendation (ambiguous, do NOT delete now):** Removing the method
> requires updating session.ts and a test. Low-value but coordinated. Leave
> for a follow-up that also revisits whether alt-screen state should
> influence agent status detection (could matter for full-screen TUI agents
> that don't run hooks).

### 9. `dispose()` — lines 337–340

Load-bearing — clears the linger timer and trackedPids on session teardown.

### 10. `transitionToComplete()` / `scheduleCompleteCleanup()` — lines 342–345, 364–374

Load-bearing. The 5 s `COMPLETE_LINGER_MS` timer is the only path that
auto-cleans an agent dot from `complete` to `gone` while the process is still
running. The relay does not schedule this cleanup; only the detector does.

### 11. `transitionToGone()` — lines 347–362

Load-bearing. Sole emitter of the `kind=null && status=idle` state that
`app-lifecycle.ts handleStreamEvent` watches for to fire
`notifyAgentDetectorGone`. The bridge depends on this exact shape.

### 12. `transition()` — lines 383–394

Load-bearing — central transition primitive. Dedupes same-status transitions
(important for hook event flurries) and clears the linger timer when
transitioning away from `complete`.

## Summary of recommendations

### Deleted in this PR (unambiguously dead)

1. **`_GENERIC_TITLES` constant** (line 23) — zero readers anywhere.
2. **`processOutput()` method** (lines 327–330) and its test
   (`agent-detector.test.ts:350-353`) — zero production callers; the test only
   asserts the no-op exists.

### Follow-up candidates (NOT touched in this PR)

These are ambiguously dead — the wiring is in place even if the runtime
behaviour is currently inert. A future ADR or ticket can remove them with a
deliberate decision:

1. **PID tracking + `sweepStalePids` + `pidSweepTimer`**. Production never
   passes a PID to `updateForegroundProcess`. The kill-9 path is already
   handled by `updateForegroundProcess(null) → transitionToGone`. Removing
   touches `agent-detector.ts`, `session.ts`, and several tests. Decision
   needed: do we ever want real PID telemetry?

2. **`setAltScreen()`**. Implementation is a no-op; session.ts call sites are
   live. Could go away with the call sites in one coordinated change.

### Confirmed load-bearing — keep as-is

- `setTitle()` and OSC 0/2 → task name pipeline (no hook-side equivalent)
- `updateForegroundProcess(name | null)` for `kind` derivation and kill-9
  detection
- `setFallbackStatus()` (load-bearing for codex/pi/opencode for
  `requires_input`, and for opencode for everything)
- `setStatus()` race-handling and `hasBeenActive` startup-Stop filter
- `transitionToComplete()` linger timer (no hook-side equivalent)
- `transitionToGone()` as the sole emitter of `kind=null && status=idle`

The detector's reason for living, post-hooks: title extraction, kill-9
recovery, and hookless-agent fallback (codex needs `requires_input`; opencode
needs everything). Roughly 60% of the file is on one of those critical paths.
