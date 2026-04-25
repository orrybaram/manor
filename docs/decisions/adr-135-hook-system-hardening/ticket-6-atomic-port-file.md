---
title: Atomic write for ~/.manor/hook-port
status: todo
priority: medium
assignee: haiku
blocked_by: []
---

# Atomic write for ~/.manor/hook-port

`AgentHookServer.start()` at `electron/agent-hooks.ts:127` writes the port file via `fs.writeFileSync(HOOK_PORT_FILE, String(this.port))`. A crash mid-write (or the file system being read by a hook script in the same instant) can yield a half-written value. The hook script's `cat "$HOME/.manor/hook-port"` then returns garbage, hooks fail, agent silently continues.

See ADR-135 §"Change 6" for context.

## What to change

Replace the writeFileSync with a tmp + rename helper. Mirror the pattern from ADR-134 ticket 1.

```ts
function writePortFileAtomic(port: number): void {
  fs.mkdirSync(path.dirname(HOOK_PORT_FILE), { recursive: true });
  const tmp = `${HOOK_PORT_FILE}.tmp`;
  fs.writeFileSync(tmp, String(port));
  fs.renameSync(tmp, HOOK_PORT_FILE);
}
```

No fsync needed — the file is regenerated every Manor boot, so durability across crashes is irrelevant. Only atomicity-against-concurrent-readers matters.

## Files to touch

- `electron/agent-hooks.ts` — replace the writeFileSync at line 127 with the helper above. Also use the same atomic write in `stop()` if anything writes there (today it only `unlinkSync`s — fine, atomic by construction).

## Tests

A quick unit test that constructs `AgentHookServer`, calls `start()`, reads the file, asserts it parses to a positive integer. Optional: assert no `.tmp` file remains in the directory after `start()` resolves.
