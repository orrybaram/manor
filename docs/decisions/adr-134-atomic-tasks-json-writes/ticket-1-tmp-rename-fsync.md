---
title: Write tasks.json atomically via tmp + fsync + rename
status: todo
priority: critical
assignee: sonnet
blocked_by: []
---

# Write tasks.json atomically via tmp + fsync + rename

`TaskManager.saveState()` in `electron/task-persistence.ts:66-77` calls `fs.writeFileSync(path, json)` directly, truncating the existing file before the new contents are written. A crash mid-write produces a truncated/empty file, and `loadState()`'s catch-all silently drops the user's task history.

See ADR-134 for full reasoning.

## What to change

Extract the disk write into a private `writeStateSync(state)` helper and replace the body with an atomic tmp + fsync + rename sequence:

```ts
private writeStateSync(state: PersistedState): void {
  fs.mkdirSync(this.dataDir, { recursive: true });
  const finalPath = this.tasksFilePath();
  const tmpPath = `${finalPath}.tmp`;
  const json = JSON.stringify(state, null, 2);

  const fd = fs.openSync(tmpPath, "w");
  try {
    fs.writeSync(fd, json);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, finalPath);
}
```

Update `saveState()` to call `writeStateSync(state)` instead of inlining the writeFileSync call. Keep the 500 ms debounce as-is — the goal is correctness within the existing cadence, not faster writes.

Do NOT touch `loadState()` in this ticket — the corruption-backup path lands in ticket 2.

## Files to touch

- `electron/task-persistence.ts` — replace the writeFileSync body with the helper above; keep the debounce timer behaviour identical.

## Notes

- `fs.fsyncSync(fd)` is required. Without it the tmp file may be in page cache only; an OS crash after `rename` returns but before the data is on disk leaves a directory entry pointing at empty blocks.
- `fs.renameSync` is atomic on POSIX (`rename(2)`) and on Windows (it maps to `MoveFileExW(MOVEFILE_REPLACE_EXISTING)` in Node).
- We do **not** fsync the parent directory. Task-history loss within a few hundred ms of a write is acceptable; a broken file is not.
