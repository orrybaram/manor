---
title: Recover requires_input zombies in sweeps + bridge + replacement
status: done
priority: critical
assignee: sonnet
blocked_by: []
---

# Recover requires_input zombies in sweeps + bridge + replacement

Four sites in `electron/hook-relay.ts` hard-code a `thinking | working` filter, leaving `requires_input` tasks unrecoverable when their underlying session disappears:

- SessionStart-replacement check (lines 153-154)
- Sweep Branch 2 (lines 322-326)
- Sweep Branch 3 (lines 346-348)
- `notifyAgentDetectorGone` (lines 366-371)

A task that ended in `requires_input` whose process died (or whose hook never fired) becomes a permanent zombie: UI shows "awaiting input" forever, pressing the input does nothing.

See ADR-135 §"Change 2" for full reasoning.

## What to change

Introduce a single shared predicate at the top of the file:

```ts
const STUCK_ACTIVE: ReadonlySet<string> = new Set(["thinking", "working", "requires_input"]);
function isStuckActive(status: string | null | undefined): boolean {
  return status != null && STUCK_ACTIVE.has(status);
}
```

Replace each of the four sites' inline `lastAgentStatus !== "thinking" && lastAgentStatus !== "working"` checks with `!isStuckActive(...)`.

Note for the SessionStart-replacement site (lines 150-155): the existing logic ignores tasks that aren't currently active. Keep the `oldState?.hasBeenActive` guard intact — only swap the status check.

Note for `notifyAgentDetectorGone` (lines 366-371): same swap; the rest of the function is unchanged.

## Files to touch

- `electron/hook-relay.ts` — add `STUCK_ACTIVE` + `isStuckActive` near other constants; replace the four inline guards.

## Tests

Extend `electron/__tests__/relay-subagent-tracking.test.ts` (or a new sibling test file):

1. Seed a task with `lastAgentStatus: "requires_input"` and no entry in `sessionStateMap`. Run `sweepStaleSessions()` after `STALE_ACTIVE_MS`. Task transitions to `responded`.
2. Same as above but `paneRootSessionMap` still points at the task's session and `notifyAgentDetectorGone` is called. Task transitions to `responded`.
3. SessionStart replacement on a pane whose old task was `requires_input`. Old task transitions to `responded`.
4. Negative: a task in `responded` is unaffected by all of the above (no spurious second notification).
