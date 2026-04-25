---
title: Remove dead unlinkPane method
status: in-progress
priority: low
assignee: haiku
blocked_by: []
---

# Remove dead unlinkPane method

`TaskManager.unlinkPane(paneId)` is defined at `electron/task-persistence.ts:195-208` and has zero callers. The two sites that want this behaviour (the relay's "task-by-pane already exists" branch at `hook-relay.ts:207-210`, and the layout's pane-close path) both inline `updateTask({ paneId: null })` directly.

See ADR-138 §"Change 2" for context.

## What to change

Delete the `unlinkPane` method from `electron/task-persistence.ts`. No call sites need to be updated — there are none.

## Files to touch

- `electron/task-persistence.ts` — delete lines 195-208.
- `electron/hook-relay.ts` — remove `unlinkPane` from `ITaskManager` interface (lines 21-27) if present.

## Verification

Before deleting, confirm zero callers:

```bash
grep "unlinkPane" electron src
```

Should produce only the definition site (and any test that tests the method directly — delete those too).

After deletion, run `pnpm typecheck` and the test suite.
