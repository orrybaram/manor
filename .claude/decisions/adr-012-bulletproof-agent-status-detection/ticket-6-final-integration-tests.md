---
title: Final integration tests — full pipeline with fallbacks
status: done
priority: critical
assignee: opus
blocked_by: [4, 5]
---

# Final Integration Tests

After all implementation is complete, add integration tests that verify the full pipeline including fallback detection. These tests prove the system is bulletproof.

## Scenarios with fallback detection

### Scenario: Hooks working — fallbacks stay quiet
1. FG → "claude"
2. Hook: UserPromptSubmit → thinking
3. Output contains "ctrl+c to interrupt" (busy pattern)
4. Verify: status is still "thinking" from hook (not overridden by fallback)
5. Hook: PreToolUse → working
6. Hook: PostToolUse → thinking
7. Hook: Stop → complete

### Scenario: Hooks fail — output patterns take over
1. FG → "claude" → idle (detected but no hook)
2. No hook fires (simulating hook failure)
3. Output contains "ctrl+c to interrupt" → fallback detects busy → thinking
4. Output contains "Yes, allow once" → fallback detects permission → requires_input
5. Output contains "❯" → fallback detects idle

### Scenario: Title-based detection
1. FG → "claude"
2. OSC title contains braille character → working (title fallback)
3. OSC title contains done marker → complete (title fallback)

### Scenario: Stale PID cleanup
1. FG → "claude"
2. Hook: UserPromptSubmit → thinking
3. Agent crashes (no Stop hook, no FG change detected)
4. PID sweep detects dead process → idle

### Scenario: Subagent tracking
1. FG → "claude"
2. Hook: UserPromptSubmit → thinking
3. Hook: SubagentStart → working
4. Hook: SubagentStop → thinking
5. Hook: Stop → complete

### Scenario: Error recovery
1. FG → "claude"
2. Hook: UserPromptSubmit → thinking
3. Hook: StopFailure → error
4. FG → null → idle (error clears when process exits)

### Scenario: Full multi-pane session
1. Pane A: FG → "claude", Hook: UserPromptSubmit → thinking
2. Pane B: FG → "claude", Hook: UserPromptSubmit → thinking
3. Pane A: Hook: PermissionRequest → requires_input
4. Session status: requires_input (highest priority across panes)
5. Pane A: Hook: PostToolUse → thinking
6. Session status: thinking (both panes thinking)
7. Pane B: Hook: Stop → complete
8. Session status: thinking (pane A still thinking)
9. Pane A: Hook: Stop → complete
10. Session status: complete (both done)

## Regression test: transition sequence snapshots
- Capture exact transition sequences for each scenario
- Store as inline snapshots (vitest toMatchInlineSnapshot)
- Any change to expected transitions fails loudly

## Files to create
- `electron/terminal-host/__tests__/agent-full-pipeline.test.ts`
- `src/store/__tests__/agent-status-multi-pane.test.ts`
