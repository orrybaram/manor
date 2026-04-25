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

# ADR-135: Hook system hardening

## Context

The hook bridge — bash script (`agent-hooks.ts:151-199`) → HTTP server (`agent-hooks.ts:48-143`) → relay state machine (`hook-relay.ts`) — is the load-bearing path that drives task lifecycle. Audit of `electron/hook-relay.ts`, `electron/agent-hooks.ts`, `electron/app-lifecycle.ts`, and the per-event registrations in `electron/agent-connectors.ts` surfaces nine independent fragility points, all on the same hot path. Bundling them keeps the surgery localized.

### Gap 1 — Sweeps and `notifyAgentDetectorGone` ignore `requires_input`

All three sweep branches in `hook-relay.ts:301-359` and `notifyAgentDetectorGone` (lines 361-381) hard-code:

```ts
if (task.lastAgentStatus !== "thinking" && task.lastAgentStatus !== "working") return;
```

A task that ended up in `requires_input` and lost its session (process killed mid-prompt, hook never fired) becomes a permanent zombie — the UI shows "awaiting input" forever, and pressing the input does nothing because the agent is gone. Same gap exists in the SessionStart-replacement branch at lines 153-154.

### Gap 2 — `Stop` / `SessionEnd` race drops pending stop

When `pendingStopAt` is set (Stop received but blocked by active subagents) and `SessionEnd` arrives before the subagent sweep clears the block, the relay deletes `sessionStateMap[sessionId]` and `paneRootSessionMap[paneId]` (lines 282-283) without firing the deferred Stop. The task is correctly transitioned to `completed`, but `unseenRespondedTasks` never gains the task id, so `maybeSendNotification` is never invoked for the "responded" transition. The user misses the "task responded" notification on a fast Stop→SessionEnd sequence.

### Gap 3 — Boot-window hook drop

`app-lifecycle.ts:296-357` order:
1. `agentHookServer.start()` — server starts accepting connections immediately.
2. `backend.connect(...)` — daemon spawns; can spawn PTYs from layout restore.
3. `createHookRelay({...})` and `agentHookServer.setRelay(relay)`.

Between steps 1 and 3, hook events that arrive at the HTTP server hit `this.relayFn?.(...)` (`agent-hooks.ts:114`) — `relayFn` is null, so events are silently null-coalesced and dropped. A fast `claude --resume` of a finished session can fire SessionStart → SessionEnd in milliseconds and lose both events.

### Gap 4 — Bash hook script parses JSON with `grep`

`agent-hooks.ts:168-177` extracts hook event fields with:
```bash
EVENT_TYPE=$(echo "$INPUT" | grep -oE '"hook_event_name"[[:space:]]*:[[:space:]]*"[^"]*"' | grep -oE '"[^"]*"$' | tr -d '"')
```

This is brittle: any escape sequence inside a JSON string (`\"`), nested objects containing the same key, or a future schema change can silently break extraction. The script `exit 0`s on every error path, and `curl ... > /dev/null 2>&1` (line 196) discards transport errors. Stale port files, daemon-restart port renumbering, and DNS oddities all fail silently.

### Gap 5 — Stale port-file race

The hook script reads `~/.manor/hook-port` on every invocation (line 164), which is correct in steady state. But on Manor restart with a fresh port number, agents whose PTY env still holds the *old* `MANOR_HOOK_PORT` will succeed at the file read (good) — unless the previous Manor crash left the file in a mid-write state, in which case the read returns whatever bytes were on disk. There is no atomic write of the port file (it uses plain `fs.writeFileSync` at `agent-hooks.ts:127`).

### Gap 6 — Wall-clock idle math in sweeps

All three sweep branches (`hook-relay.ts:307`, `320`, `351`) compare `Date.now()` differences. After a laptop suspend/resume, every active task's "idle" duration is suddenly ≥ the configured threshold, so the sweep force-completes everything alive on first wake. Same issue with `Date.parse(task.activatedAt)` against `Date.now()` for orphans.

### Gap 7 — `agentKind` defaults to `"claude"` in hook URL

`agent-hooks.ts:100`:
```ts
const kind = (url.searchParams.get("kind") ?? "claude") as AgentKind;
```

The bash hook script reads `MANOR_AGENT_KIND` from the spawning shell's env (line 180). If the connector forgot to inject this when registering, or the user runs an unsupported agent, kind falls back to `"claude"` and the task is mislabelled. Pi's TS hook (`agent-connectors.ts:395`) hard-codes `kind: "pi"` — fine — but the bash path has no equivalent guarantee.

### Gap 8 — `Notification` matcher trust

`ClaudeConnector` registers Notification with matcher `"permission_prompt"` (`agent-connectors.ts:57`), and `mapEventToStatus` flips Notification to `requires_input` (`agent-hooks.ts:35`). But Claude Code fires the Notification hook for many reasons; the matcher is documented to filter, but Manor takes any Notification that arrives as authoritative. A spurious or future-added Notification flips the task to `requires_input` until something else clears it.

### Gap 9 — Task `cwd` is never refreshed

`task.cwd` is set once at task creation from `paneContext.workspacePath` (`hook-relay.ts:221`). Live cwd is tracked separately on the daemon session via OSC 7 and emitted as a `cwd` stream event (`app-lifecycle.ts:126-128`), but never propagated to the task. A task initiated in `~/Code/foo`, where the user `cd`s into a subdirectory mid-session, continues to show the original cwd in `tasks.json` and the history modal.

## Decision

Nine focused changes in three files. Each is independently testable and idempotent. Order matters only for the boot-window gap (Gap 3) which gates correctness of the others on app start.

### Change 1 — Buffer hook events until relay is wired

In `AgentHookServer` (`agent-hooks.ts`), buffer events received before `setRelay()` is called. Replay them, in order, the first time `setRelay` runs.

```ts
class AgentHookServer {
  private relayFn: RelayFn | null = null;
  private pending: Array<Parameters<RelayFn>> = [];

  setRelay(relay: RelayFn): void {
    this.relayFn = relay;
    const queued = this.pending;
    this.pending = [];
    for (const args of queued) relay(...args);
  }

  // In the request handler, after computing (paneId, status, kind, sessionId, eventType, toolUseId):
  if (this.relayFn) {
    this.relayFn(paneId, status, kind, sessionId, eventType, toolUseId);
  } else {
    this.pending.push([paneId, status, kind, sessionId, eventType, toolUseId]);
  }
}
```

Cap `pending` at e.g. 1000 entries (drop-newest with a warn log if exceeded) to bound memory under pathological boot conditions.

### Change 2 — `requires_input` everywhere a "stuck active" check exists

In `electron/hook-relay.ts`, replace every `lastAgentStatus !== "thinking" && !== "working"` guard with a shared predicate:

```ts
const STUCK_ACTIVE: ReadonlySet<string> = new Set(["thinking", "working", "requires_input"]);
function isStuckActive(status: string | null | undefined): boolean {
  return status !== null && status !== undefined && STUCK_ACTIVE.has(status);
}
```

Apply at:
- SessionStart replacement (lines 153-154)
- Sweep Branch 2 (lines 322-326)
- Sweep Branch 3 (lines 346-348)
- `notifyAgentDetectorGone` (lines 366-371)

A `requires_input` task whose underlying session is gone now self-heals via the same paths that already recover thinking/working zombies.

### Change 3 — Apply pending Stop on SessionEnd race

In `hook-relay.ts:269-283` (the `SessionEnd` arm), if `sessionState.pendingStopAt !== null` at entry, fire `applyStopForSession(sessionId)` before transitioning to `completed`:

```ts
} else if (eventType === "SessionEnd") {
  if (sessionState.pendingStopAt !== null) {
    sessionState.activeSubagents.clear();
    sessionState.pendingStopAt = null;
    applyStopForSession(sessionId);
    // re-fetch task — it now has lastAgentStatus: "responded"
    task = taskManager.getTaskBySessionId(sessionId);
  }
  if (task) {
    // ... existing completed transition
  }
  // ... existing cleanup
}
```

This ensures `unseenRespondedTasks` gains the task id and the responded notification fires, before completion overwrites the status.

### Change 4 — Monotonic clock for sweep idle

Stamp `lastHookEventAt` and `activatedAtMonotonic` from `process.hrtime.bigint()` (nanoseconds, never goes backward, doesn't jump on suspend). Convert to milliseconds for comparisons.

```ts
function nowMonoMs(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

interface SessionState {
  // ...
  lastHookEventAt: number;          // monotonic ms
}
```

For tasks (which need a value across process restarts), keep `activatedAt` as ISO wall-clock for display but add an in-memory monotonic floor: at relay startup, record `bootMonoMs = nowMonoMs()` and `bootWallMs = Date.now()`. For each task, `monotonicAge = max(0, nowMonoMs() - bootMonoMs - max(0, Date.now() - bootWallMs - (Date.now() - Date.parse(task.activatedAt))))` — i.e. clamp the apparent age to wall delta since boot if wall and monotonic disagree by > some epsilon.

Simpler alternative: only enforce the monotonic guard for `SessionState`-scoped sweeps (Branches 1 + 2) where the timestamp originated in this process. For Branch 3 (orphan-task sweep), keep the wall-clock check **but** add a "monotonic minimum age" gate: a task can only be force-completed if at least `STALE_ACTIVE_MS` of *monotonic* time has passed since the relay started. After a suspend, this prevents the immediate flush.

Pick the simpler alternative — full mono/wall reconciliation is overkill for a 60-second threshold. See ticket for exact code.

### Change 5 — Pi-style robust JSON parsing for the bash hook

Two options:

**Option A** — replace the bash hook with a thin Node entry script that the same connectors reference. JSON.parse is correct, errors are loggable. Cost: requires a Node runtime on the agent's PATH (true today since users are running Manor; agent CLIs are also Node-based).

**Option B** — keep bash but use `jq` if available, fall back to a stricter awk parser, only fall back to grep as last resort.

Pick **Option A** — Node availability is already required for Manor's MCP server (`agent-connectors.ts:135-172`), so this is already a valid assumption. New file: `electron/scripts/agent-hook.js`. The bash wrapper is removed; the connector points hooks at `node /path/to/agent-hook.js`.

The Node script is straightforward (read JSON from stdin, build URL, GET it, exit 0). Errors logged to stderr, which Claude Code's hook subsystem surfaces in its debug logs.

### Change 6 — Atomic port-file write

In `agent-hooks.ts:127`, replace:
```ts
fs.writeFileSync(HOOK_PORT_FILE, String(this.port));
```

with a tmp+rename helper (mirroring ADR-134's pattern). One-line write so corruption is unlikely, but cheap to make airtight.

### Change 7 — Validate `agentKind` against connector registry

In the HTTP request handler (`agent-hooks.ts:100`), refuse unknown kinds rather than coercing:

```ts
const rawKind = url.searchParams.get("kind");
const kind = isKnownAgentKind(rawKind) ? rawKind : null;
if (!kind) {
  console.warn(`[agent-hooks] hook with unknown kind=${rawKind} from pane=${paneId}; dropping`);
  res.writeHead(400);
  res.end();
  return;
}
```

Where `isKnownAgentKind` introspects `getAllConnectors()`. Drops the silent claude-fallback that mislabels other agents.

Also ensure every connector sets `MANOR_AGENT_KIND` in the spawn env. `ClaudeConnector` and `CodexConnector` rely on the bash script's `KIND=${MANOR_AGENT_KIND:-claude}` default, but nothing actually injects `MANOR_AGENT_KIND=claude` for Claude — the env var only gets set for non-claude agents (if at all). Audit the connector spawn paths and inject explicitly per kind.

### Change 8 — Specific Notification matcher

Tighten `ClaudeConnector.registerHooks` so the Notification entry uses the exact matcher Claude Code documents for permission prompts (or a regex / event-id check at the relay layer). Where the matcher is non-load-bearing in Claude's hook system, fall back to filtering at the relay: in `mapEventToStatus`, return `null` for Notification events whose payload (passed via the URL param) does not indicate a permission-style notification.

Implementation: extend the bash/Node hook script to forward a `notification_kind` query param when the event payload's `notification` field has a recognizable shape. Relay-side, only map to `requires_input` when `notification_kind === "permission"`.

Land as a follow-up — Claude's hook payload schema needs verification on a recent build before tightening.

### Change 9 — Refresh `task.cwd` from OSC 7 stream events

In `app-lifecycle.ts:126-128`, when a `cwd` stream event arrives for a session, also update the task:

```ts
case "cwd": {
  mainWindow.webContents.send(`pty-cwd-${event.sessionId}`, event.cwd);
  const task = taskManager.getTaskByPaneId(event.sessionId);
  if (task && task.cwd !== event.cwd && task.status === "active") {
    const updated = taskManager.updateTask(task.id, { cwd: event.cwd });
    if (updated) {
      try {
        mainWindow.webContents.send("task-updated", updated);
      } catch { /* ignore */ }
    }
  }
  break;
}
```

Only update active tasks (no point churning history). The 500 ms debounce on `saveState` already coalesces rapid `cd`s.

## Consequences

**Better:**
- Boot-window hooks no longer dropped (Change 1).
- `requires_input` zombies self-heal (Change 2).
- Stop→SessionEnd races no longer miss notifications (Change 3).
- Laptop suspend doesn't force-complete everything (Change 4).
- Hook payload parsing is correct, errors loggable (Change 5).
- Port-file corruption ruled out (Change 6).
- Mislabelled agent kinds become visible (Change 7).
- Spurious Notification events stop hijacking task status (Change 8).
- Live cwd visible in task history (Change 9).

**Tradeoffs:**
- Change 1's buffering caps memory at ~1000 events; pathological boot loops could lose events at the cap. Acceptable given a `console.warn` and the cap size.
- Change 5 introduces one new file and a Node-process spawn per hook. Per-hook latency rises from ~5 ms (bash+curl) to ~30-50 ms (node startup + HTTP). Hook events are off the user's critical path; this is fine.
- Change 7 makes hooks with unknown `kind` fail loudly. Could break a user manually invoking the hook script for testing — they will see a 400 and a warn log, which is the desired UX.
- Change 8 needs payload-schema verification before shipping; ticket flagged as `priority: medium` and explicitly post-others.

**Risks:**
- Change 4's monotonic-floor approach is conservative; the fallback could still allow spurious force-completion if the user hibernates immediately after task creation (before the floor is established). The window is small (one sweep interval = 10 s) and the failure mode is "task ends sooner than ideal", not "task ends silently".
- Change 5 (Node hook) breaks if the user's Node binary is missing from the agent's PATH. Detect at registration time and fall back to the bash script with a warning.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
