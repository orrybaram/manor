---
title: Stage claudeSessionId migration for removal next release
status: done
priority: low
assignee: sonnet
blocked_by: []
---

# Stage claudeSessionId migration for removal next release

`loadState` at `electron/task-persistence.ts:53-57` migrates legacy `claudeSessionId → agentSessionId` on every boot. Anyone who has run a migrated build once already has clean records on disk. The branch is cheap but it grows the load path and the test surface.

This ticket is **step 1 of two** — bake the migration into a single one-shot pass on disk so the next release can delete the in-loop branch entirely.

See ADR-138 §"Change 3" for full reasoning.

## What to change

In `electron/task-persistence.ts`:

1. After `loadState` finishes, check whether *any* task in the loaded Map went through the rename branch (i.e. originally had `claudeSessionId` populated). Track this with a boolean.
2. If any did, schedule an immediate `saveState()` so the rewritten file no longer contains the legacy key on disk.

Concretely:

```ts
private migrationPerformed = false;

private loadState(): Map<string, TaskInfo> {
  // ... existing read + parse ...
  for (const task of state.tasks ?? []) {
    const migrated = task as TaskInfo & { claudeSessionId?: string };
    if (!migrated.agentSessionId && migrated.claudeSessionId) {
      migrated.agentSessionId = migrated.claudeSessionId;
      delete migrated.claudeSessionId;
      this.migrationPerformed = true;
    }
    map.set(migrated.agentSessionId, migrated);
  }
  return map;
}

constructor(dataDir?: string) {
  // ...
  this.tasks = this.loadState();
  if (this.migrationPerformed) {
    // Force an immediate save so future loads don't re-migrate.
    // Bypass the debounce by writing directly:
    this.flushNow();
  }
}

private flushNow(): void {
  if (this.saveTimer) {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
  }
  // ... call writeStateSync from ADR-134 ...
}
```

(`flushNow` should use the atomic write helper from ADR-134 ticket 1; if that ticket hasn't landed, just call the existing writeFileSync but make it synchronous and immediate.)

## Files to touch

- `electron/task-persistence.ts` — track migration; flush immediately on first load that needed it.

## Tests

- New `task-persistence.test.ts` case: pre-write a `tasks.json` containing a task with `claudeSessionId`. Construct a TaskManager. Read the file back from disk — it must no longer contain the legacy key.
- Idempotence: construct a TaskManager twice over the same data dir. Second construction does NOT trigger another flush (`migrationPerformed === false`).

## Notes

The actual deletion of the in-loop migration branch is **NOT in this ticket**. That deletion lands in a follow-up ADR after this ticket's behaviour ships and reaches users. Do not anticipate it.
