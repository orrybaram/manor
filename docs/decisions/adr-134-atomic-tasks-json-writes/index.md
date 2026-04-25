---
type: adr
status: proposed
database:
  schema:
    status:
      type: select
      options: [todo, in-progress, review, done]
      default: todo
    priority:
      type: select
      options: [critical, high, medium, low]
    assignee:
      type: select
      options: [opus, sonnet, haiku]
  defaultView: board
  groupBy: status
---

# ADR-134: Atomic writes for `tasks.json`

## Context

`TaskManager.saveState()` (`electron/task-persistence.ts:66-77`) persists every task mutation via:

```ts
this.saveTimer = setTimeout(() => {
  this.saveTimer = null;
  const tasks = Array.from(this.tasks.values());
  const state: PersistedState = { tasks };
  fs.mkdirSync(this.dataDir, { recursive: true });
  fs.writeFileSync(this.tasksFilePath(), JSON.stringify(state, null, 2));
}, 500);
```

Two failure modes:

1. **Non-atomic write.** `fs.writeFileSync(path, data)` is a single `open(O_WRONLY|O_TRUNC)` + `write` + `close`. The file is truncated to zero bytes the moment `open` returns. If the process is killed (force-quit, OS reboot, OOM, hardware crash) between truncation and the final write completing, `tasks.json` lands on disk truncated — possibly empty, possibly half-written.

2. **Silent loss on parse failure.** `loadState()` (lines 46-64) wraps the read in `try { ... } catch { return new Map(); }`. A corrupted file produces an empty `Map` and the user's entire task history is silently dropped on the next save. There is no log, no warning, no backup.

The 500 ms debounce means the window is small but real — Manor force-quitting during a busy hook burst is a routine occurrence.

There is also no `fsync`. After a `fs.writeFileSync` returns, the data is in the kernel page cache; an OS crash within seconds can still lose it.

## Decision

Three changes, all in `electron/task-persistence.ts`:

### 1. Write atomically via tmp + rename

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

`rename(2)` on POSIX (and `MoveFileExW(MOVEFILE_REPLACE_EXISTING)` on Win32, which `fs.renameSync` uses on Windows) is atomic with respect to the destination — readers see either the old contents or the new contents, never a partial mid-write.

### 2. fsync before rename

`fs.fsyncSync(fd)` flushes the tmp file's data to disk before the rename. Without it, an OS crash after `rename` returns but before the new contents hit the platter can leave the directory entry pointing at empty data blocks. With it, the tmp file is durable before the rename swaps it in.

We do NOT fsync the directory (overkill for this use case — task history loss within a few hundred ms of a write is acceptable; a broken file is not).

### 3. Backup-on-corruption in `loadState`

Replace the silent `catch { return new Map() }` with:

```ts
private loadState(): Map<string, TaskInfo> {
  let data: string;
  try {
    data = fs.readFileSync(this.tasksFilePath(), "utf-8");
  } catch (err) {
    // ENOENT — first launch, no file yet
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error("[TaskManager] Failed to read tasks.json:", err);
    }
    return new Map();
  }

  try {
    const state: PersistedState = JSON.parse(data);
    // ... existing migration + Map building
  } catch (err) {
    // Corrupted file — preserve it for debugging before we let the empty Map clobber on next save
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

A user with a corrupted file gets a `.corrupt-<ts>` next to it for recovery, plus a console error. The empty-Map fallback still happens — we do not block boot — but data is no longer silently destroyed.

## Consequences

**Better:**
- Force-quit during the 500 ms debounce window can no longer corrupt task history.
- Corrupted files are preserved for recovery instead of being silently overwritten.
- OS crash within seconds of a save no longer loses the most recent write.

**Tradeoffs:**
- Each save now does `open` + `write` + `fsync` + `close` + `rename` instead of a single `writeFileSync`. `fsync` is the expensive call (a few ms on SSD, longer on spinning disk). With a 500 ms debounce floor and small file sizes (kB), the cost is negligible at human scale.
- The tmp file path (`tasks.json.tmp`) is observable on disk if Manor is killed mid-fsync. Acceptable — it's small, named clearly, and gets overwritten on next save.

**Risks:**
- If `rename` fails (disk full, permission flip), the user still has the *old* `tasks.json` intact. Today's `writeFileSync` in the same situation would leave the file truncated. So this is strictly better.
- `fs.copyFileSync` in the corruption branch can itself fail (disk full, etc.). The `try/catch` around it ensures boot still succeeds.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
