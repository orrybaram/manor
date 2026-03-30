---
title: Fallback detection — output patterns, title parsing, PID sweep
status: done
priority: critical
assignee: opus
blocked_by: [4]
---

# Fallback Detection Pipeline

When hooks fail to fire (crash, timeout, misconfigured, non-Claude agent), Manor must still detect status correctly. Implement three fallback strategies.

## Fallback 1: Terminal output pattern matching

Create `electron/terminal-host/output-pattern-matcher.ts`.

### Busy indicators (→ thinking or working)
- `"ctrl+c to interrupt"` — agent is actively running
- `"esc to interrupt"` — agent is actively running
- Braille spinner characters (U+2800–U+28FF) — Claude Code's activity spinners
- Whimsical action words + "..." + "tokens" pattern (e.g. "✢ Cerebrating... (53s, 749 tokens)")

### Requires input indicators (→ requires_input)
- `"Yes, allow once"` — permission dialog
- `"No, and tell Claude what to do differently"` — permission dialog
- `"Do you trust the files in this folder?"` — trust dialog
- `"(Y/n)"` — yes/no prompt
- `"Continue?"` — continuation prompt
- `"Approve this plan?"` — plan approval

### Idle indicators (→ idle)
- `❯` or `>` alone on last non-empty line (after ANSI stripping)

### Implementation
- Maintain a ring buffer of last 15 lines of ANSI-stripped terminal output
- On each DATA frame, update the buffer and check patterns
- Skip lines starting with box-drawing characters (│├└─) to avoid false positives from UI borders
- Feed detected status to AgentDetector as `setFallbackStatus()` — lower priority than hook events
- Debounce: don't override a hook-driven status within 2s of the last hook event

### Tests (`electron/terminal-host/__tests__/output-pattern-matcher.test.ts`)
- Each busy pattern matches correctly
- Each requires_input pattern matches correctly
- Idle pattern matches
- Box-drawing lines are skipped
- ANSI codes are stripped before matching
- No false positives from normal shell output
- No false positives from Claude's welcome banner
- Debounce: pattern status doesn't override recent hook status

## Fallback 2: Pane title detection

Create `electron/terminal-host/title-detector.ts`.

Claude Code sets terminal titles via OSC 0/2 escape sequences. Parse these in Session alongside the existing OSC 7 parser.

### Detection rules
- Braille characters (U+2800–U+28FF) in title → working/thinking
- Done markers (✳✻✽✶✢) in title → complete
- Otherwise → unknown (don't override)

### Integration
- Extend `Session.parseOsc7()` to also capture OSC 0 and OSC 2 (set title)
- Feed detected title state to AgentDetector as another fallback signal
- Priority: hooks > output patterns > title > process polling

### Tests (`electron/terminal-host/__tests__/title-detector.test.ts`)
- Braille chars detected correctly
- Done markers detected correctly
- Normal titles return unknown
- Mixed content (braille + text) detected

## Fallback 3: Stale PID sweep

### Implementation
- AgentDetector gets a `sweepStalePids()` method
- Called every 30s from Session (or from a centralized timer)
- For each tracked agent with a non-idle status:
  - Call `process.kill(pid, 0)` — sends no signal, just checks existence
  - If throws with code ESRCH → process is dead → force transition to idle
  - If throws with code EPERM → process exists but no permission → keep tracking
- Clear all timers on dispose()

### Tests
- Dead PID (mock kill throwing ESRCH) → forces idle
- Live PID (mock kill succeeding) → no change
- No-permission PID (mock kill throwing EPERM) → no change
- Sweep with no tracked agents → no-op
- Multiple stale agents cleaned up in one sweep

## Files to create
- `electron/terminal-host/output-pattern-matcher.ts`
- `electron/terminal-host/title-detector.ts`
- `electron/terminal-host/__tests__/output-pattern-matcher.test.ts`
- `electron/terminal-host/__tests__/title-detector.test.ts`

## Files to modify
- `electron/terminal-host/agent-detector.ts` — add setFallbackStatus(), sweepStalePids(), signal priority
- `electron/terminal-host/session.ts` — wire in output parser, title parser, PID sweep timer
