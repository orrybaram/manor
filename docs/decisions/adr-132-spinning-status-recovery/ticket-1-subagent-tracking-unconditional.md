---
title: Track SubagentStart/Stop regardless of event status
status: done
priority: critical
assignee: sonnet
blocked_by: []
---

# Track SubagentStart/Stop regardless of event status

In `electron/hook-relay.ts`, the add/remove bookkeeping for `activeSubagents` lives inside the `if (ACTIVE_STATUSES.has(status))` branch (lines 170–183). Terminal `SubagentStop` events normally carry a non-active status (e.g. `complete`, `idle`) and therefore never reach the `.delete()` call. The subagent stays in `activeSubagents` forever, which blocks the parent `Stop` at line 245 and forces the task to wait on the 15 s stale-stop sweep (or never recover if hook activity keeps refreshing `lastHookEventAt`).

See ADR-132 §"Fix 1" for full reasoning.

## What to change

Move the `SubagentStart` / `SubagentStop` add/remove block **out of** the `ACTIVE_STATUSES` guard. The subagent-tracking logic is orthogonal to the event's `status` field — the `eventType` name is authoritative.

Keep `hasBeenActive = true` set only inside the `ACTIVE_STATUSES` branch (a bare `SubagentStart` with idle status should not be treated as "the agent became active").

Do not otherwise change control flow. In particular, the subsequent early return after the `ACTIVE_STATUSES` block and the terminal-event handling below must be unaffected.

Target shape (inside `relay()`, after setting `sessionState.lastHookEventAt`):

```ts
if (eventType === "SubagentStart") {
  const id = toolUseId ?? `__fallback_${sessionState.activeSubagents.size}`;
  sessionState.activeSubagents.add(id);
} else if (eventType === "SubagentStop") {
  if (toolUseId) {
    sessionState.activeSubagents.delete(toolUseId);
  } else {
    const first = sessionState.activeSubagents.values().next().value;
    if (first !== undefined) sessionState.activeSubagents.delete(first);
  }
}

if (ACTIVE_STATUSES.has(status)) {
  sessionState.hasBeenActive = true;
  // ...existing task-active branch UNCHANGED except the two SubagentStart/Stop
  //    blocks have moved above.
}
```

Remove the two moved blocks from inside the `ACTIVE_STATUSES` branch so they are not duplicated.

## Files to touch

- `electron/hook-relay.ts` — relocate the SubagentStart/SubagentStop add/remove logic per above; leave `hasBeenActive` and the rest of the active-branch body as-is.

Do NOT update tests in this ticket — tests land in ticket 4.
