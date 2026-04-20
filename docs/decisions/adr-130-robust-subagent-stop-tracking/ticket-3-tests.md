---
title: Tests for subagent Set tracking and stale-Stop safety net
status: done
priority: medium
assignee: sonnet
blocked_by: [1, 2]
---

# Tests for subagent Set tracking and stale-Stop safety net

Unit tests covering both fixes from tickets 1 and 2.

## Files to touch

### `electron/__tests__/agent-hooks.test.ts` — extend

Add tests for `toolUseId` plumbing through the HTTP server.

```ts
describe("toolUseId forwarding", () => {
  it("passes toolUseId to relay when present in query", async () => {
    await httpGet(
      server.hookPort,
      "/hook/event?paneId=p1&eventType=SubagentStart&toolUseId=abc123",
    );
    expect(relayFn).toHaveBeenCalledWith(
      "p1",
      "working",
      "claude",
      null,
      "SubagentStart",
      "abc123",
    );
  });

  it("passes null toolUseId when absent", async () => {
    await httpGet(
      server.hookPort,
      "/hook/event?paneId=p1&eventType=Stop",
    );
    expect(relayFn).toHaveBeenCalledWith(
      "p1",
      "responded",
      "claude",
      null,
      "Stop",
      null,
    );
  });
});
```

Update the `relayFn` declaration in `beforeEach` to match the new 6-argument signature.

Update existing `relay callback invocation` assertions (around line 178) to expect the new `toolUseId` argument (`null` where not specified).

### `electron/__tests__/hook-script.test.ts` — create

Verify the shell hook script extracts `tool_use_id` from a sample payload and sends it as a URL param.

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { HOOK_SCRIPT_PATH, ensureHookScript } from "../agent-hooks";
```

Stand up a small HTTP server on a random port, write the port to the hook-port file (use `paths.ts` helpers), and invoke the hook script as a subprocess via `bash HOOK_SCRIPT_PATH` with:

- `MANOR_PANE_ID=pane-1` in env
- stdin containing a JSON payload like:
  ```json
  {"hook_event_name":"SubagentStart","session_id":"parent-sess","tool_use_id":"tool-xyz"}
  ```

Wait briefly (200ms) for the curl callback, then assert that the HTTP server received the expected query params including `toolUseId=tool-xyz`.

Also test a payload without `tool_use_id` to confirm the param is omitted.

Keep this test isolated — use a temp-dir HOME via `process.env.HOME` override so the production `~/.manor/hook-port` file isn't clobbered.

### `electron/__tests__/relay-subagent-tracking.test.ts` — create

Unit-test the relay callback logic by extracting it (or by using a test harness that stubs `taskManager` / `backend` / `mainWindow`).

**Option A** (preferred, requires minor refactor to ticket 1 or 2): extract the relay callback body into a named function exported for tests, e.g. `createHookRelay(deps): RelayFn`. Tests construct it with fake deps and drive it with synthetic events.

**Option B** (if refactor is out of scope): test `SessionState` behavior directly by exporting `getOrCreateSessionState` and the Set mutation helpers.

Pick whichever is cleaner given the state of tickets 1 and 2. Lean on Option A if the relay is already large; otherwise Option B is fine.

Cover these cases:

1. **Subagent Set — duplicate SubagentStart**: fire `SubagentStart` twice with the same `toolUseId`; confirm `activeSubagents.size === 1`. Then `Stop` → dropped. Then `SubagentStop` → `activeSubagents.size === 0`. Then `Stop` → applied.
2. **Subagent Set — missing SubagentStop**: fire `SubagentStart` with `toolUseId=a`, then `Stop` → dropped (size=1, pendingStopAt set).
3. **Safety-net recovery**: reuse scenario 2, advance fake time by 16s (using `vi.useFakeTimers()` + `vi.advanceTimersByTime`), run the sweep, assert `applyStopForSession` is called.
4. **Safety-net defers on fresh activity**: scenario 2, advance 10s, fire `PostToolUse` (resets `lastHookEventAt`), advance 10s more (total 20s of wall clock, but only 10s since last event), run sweep → NOT applied.
5. **SubagentStop with unknown toolUseId**: fire `SubagentStop` with an id not in the Set → no-op, no negative state.
6. **Fallback id when toolUseId is null**: fire `SubagentStart` with `toolUseId=null` → stored under synthesized fallback id, size becomes 1.

## Verification

- `npm run typecheck` passes.
- `npm test -- electron/__tests__` passes (new and existing tests).

## REQUIRED: Commit your work

When your implementation is complete, you MUST create a git commit. This is not optional.

Run:
  git add -A
  git commit -m "test(adr-130): cover subagent Set tracking and stale-Stop safety net"

Do not push.
