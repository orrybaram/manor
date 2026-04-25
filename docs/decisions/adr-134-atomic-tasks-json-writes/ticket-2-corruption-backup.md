---
title: Preserve corrupted tasks.json instead of silently clobbering
status: todo
priority: high
assignee: sonnet
blocked_by: [1]
---

# Preserve corrupted tasks.json instead of silently clobbering

`TaskManager.loadState()` in `electron/task-persistence.ts:46-64` wraps the read+parse in a single `try { ... } catch { return new Map(); }`. A corrupted file silently becomes an empty Map, and the next `saveState()` overwrites the file — destroying any data the user could have recovered manually.

See ADR-134 for full reasoning.

## What to change

Split read errors from parse errors, and on parse failure copy the bad file aside before returning the empty Map.

Target shape:

```ts
private loadState(): Map<string, TaskInfo> {
  let data: string;
  try {
    data = fs.readFileSync(this.tasksFilePath(), "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error("[TaskManager] Failed to read tasks.json:", err);
    }
    return new Map();
  }

  try {
    const state: PersistedState = JSON.parse(data);
    const map = new Map<string, TaskInfo>();
    for (const task of state.tasks ?? []) {
      const migrated = task as TaskInfo & { claudeSessionId?: string };
      if (!migrated.agentSessionId && migrated.claudeSessionId) {
        migrated.agentSessionId = migrated.claudeSessionId;
        delete migrated.claudeSessionId;
      }
      map.set(migrated.agentSessionId, migrated);
    }
    return map;
  } catch (err) {
    const corruptPath = `${this.tasksFilePath()}.corrupt-${Date.now()}`;
    try {
      fs.copyFileSync(this.tasksFilePath(), corruptPath);
      console.error(
        `[TaskManager] tasks.json is corrupted (${(err as Error).message}); ` +
          `preserved a copy at ${corruptPath}`,
      );
    } catch (copyErr) {
      console.error("[TaskManager] Failed to back up corrupted tasks.json:", copyErr);
    }
    return new Map();
  }
}
```

ENOENT (file does not exist — first launch) stays silent. Any other read error logs but still returns the empty Map so boot proceeds.

## Files to touch

- `electron/task-persistence.ts` — replace `loadState()` body per above.

## Tests

Add to `electron/task-persistence.test.ts`:

1. Corrupted-file backup: create a `TaskManager(tmpDir)` after pre-writing invalid JSON to `tasks.json`. Assert the constructor returns a working manager (`getAllTasks()` is empty), and that `tasks.json.corrupt-<ts>` exists with the original bad bytes.
2. ENOENT path: pointing at a directory with no `tasks.json` produces an empty manager and writes nothing on construction (confirms no spurious save).
3. Read error other than ENOENT: simulate via a directory at the path (read of a directory raises EISDIR). Assert empty Map and that no `.corrupt-` file is created (we couldn't read the contents to copy them).
