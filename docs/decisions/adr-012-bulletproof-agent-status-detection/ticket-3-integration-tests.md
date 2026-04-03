---
title: E2E lifecycle scenario tests — full pipeline verification
status: done
priority: critical
assignee: opus
blocked_by: [1, 2]
---

# E2E Lifecycle Scenario Tests

Integration tests that replay realistic agent session lifecycles and verify the EXACT sequence of status transitions. These tests prove the system works end-to-end by simulating the inputs that would come from a real Claude Code session.

Each scenario wires up an AgentDetector, feeds it a sequence of foreground process changes and hook events, and captures every status transition callback. The captured sequence is compared against the expected sequence.

## Test infrastructure

```typescript
// Helper to capture transition sequences
function createTestHarness() {
  const detector = new AgentDetector();
  const transitions: AgentState[] = [];
  detector.onStatusChange = (state) => transitions.push({ ...state });
  return { detector, transitions };
}
```

Use vitest fake timers for all scenarios.

## Scenarios

### Scenario 1: Normal Claude session (happy path)
```
Input sequence:
1. FG → "claude"                    // agent appears
2. Hook: UserPromptSubmit           // user sends prompt
3. Hook: PostToolUse                // tool finished
4. Hook: Stop                       // agent done
5. Hook: UserPromptSubmit           // another prompt
6. Hook: PermissionRequest          // needs permission
7. Hook: PostToolUse                // permission granted, tool ran
8. Hook: Stop                       // done again
9. FG → null                        // agent exits
10. advance timer 3000ms            // complete clears

Expected transitions:
[running, running(no-op), waiting, running, waiting, running, waiting, complete, idle]
```

### Scenario 2: Agent crash (no Stop hook)
```
1. FG → "claude"
2. Hook: UserPromptSubmit → running
3. FG → null                        → complete (no Stop received)
4. advance 3000ms                   → idle
```

### Scenario 3: Rapid agent restart
```
1. FG → "claude"
2. Hook: UserPromptSubmit → running
3. FG → null              → complete
4. FG → "claude"          → idle (timer cleared, new agent)
5. Hook: UserPromptSubmit → running
```

### Scenario 4: Agent spawns child processes
```
1. FG → "claude"
2. Hook: UserPromptSubmit → running
3. FG → "git"             → (no change — agent spawned git)
4. FG → "node"            → (no change — still agent's child)
5. FG → "claude"          → (no change — still running)
6. Hook: Stop             → waiting
```

### Scenario 5: Permission → approval → tool use cycle
```
1. FG → "claude"
2. Hook: UserPromptSubmit → running
3. Hook: PermissionRequest → waiting
4. Hook: PostToolUse       → running (user approved, tool ran)
5. Hook: PermissionRequest → waiting (another permission)
6. Hook: PostToolUse       → running
7. Hook: Stop              → waiting
8. FG → null               → complete
```

### Scenario 6: Multiple tool uses in sequence
```
1. FG → "claude"
2. Hook: UserPromptSubmit  → running
3. Hook: PostToolUse       → running (no-op)
4. Hook: PostToolUse       → running (no-op)
5. Hook: PostToolUseFailure → running (no-op, tool failed but agent continues)
6. Hook: PostToolUse       → running (no-op)
7. Hook: Stop              → waiting
```

### Scenario 7: Agent detected but never gets hook event
```
1. FG → "claude"           → (idle, just detected)
2. advance 60000ms         → (still idle — no hook means no dot)
3. FG → null               → (still idle — never was running)
```

### Scenario 8: Hook fires before process detected (race condition)
```
1. Hook: UserPromptSubmit  → (ignored — no agent kind set)
2. FG → "claude"           → (idle)
3. Hook: UserPromptSubmit  → running (now it works)
```

### Scenario 9: opencode agent (different kind)
```
1. FG → "opencode"
2. Hook: UserPromptSubmit → running (kind: "opencode")
3. Hook: Stop             → waiting
4. FG → null              → complete
```

### Scenario 10: Rapid status flapping
```
1. FG → "claude"
2. Hook: UserPromptSubmit → running
3. Hook: PermissionRequest → waiting
4. Hook: UserPromptSubmit → running (user responded instantly)
5. Hook: Stop → waiting
6. Hook: UserPromptSubmit → running (rapid follow-up)
7. Hook: Stop → waiting

Verify no transitions were lost or coalesced
```

## Store integration tests

### setPaneAgentStatus
- Updates store for each status value
- Removes entry when status is "idle"
- Deduplicates: same status+kind → no state update
- Different paneIds are independent
- Handles rapid updates without lost writes

### useSessionAgentStatus priority aggregation
- Single pane: returns that pane's status
- Multiple panes: waiting > running > error > complete > idle
- Pane goes idle → falls back to next highest
- All panes idle → returns null
- New pane added → recalculates

## Files to create
- `electron/terminal-host/__tests__/agent-lifecycle.test.ts`
- `src/store/__tests__/agent-status-store.test.ts`
