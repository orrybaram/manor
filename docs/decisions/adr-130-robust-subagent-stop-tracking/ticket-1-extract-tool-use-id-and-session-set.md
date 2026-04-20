---
title: Extract tool_use_id in hook script and track subagents as a Set
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Extract tool_use_id in hook script and track subagents as a Set

Replace `subagentCount: number` with `activeSubagents: Set<string>` so subagent tracking is idempotent. Pipe the subagent's `tool_use_id` from Claude's hook payload through the HTTP hook endpoint to the relay callback so we can identify individual subagents.

## Files to touch

### `electron/agent-hooks.ts`

**Hook script (`HOOK_SCRIPT` constant, lines 148-190)** — add a `tool_use_id` extraction step, same pattern as the existing `session_id` extraction. The field may be absent (non-subagent events). Forward as `toolUseId` URL param, only when present.

```bash
# After the existing SESSION_ID extraction, add:
TOOL_USE_ID=$(echo "$INPUT" | grep -oE '"tool_use_id"[[:space:]]*:[[:space:]]*"[^"]*"' | grep -oE '"[^"]*"$' | tr -d '"')
```

Then extend `CURL_ARGS`:

```bash
if [ -n "$TOOL_USE_ID" ]; then
  CURL_ARGS+=(--data-urlencode "toolUseId=$TOOL_USE_ID")
fi
```

Place this after the existing `SESSION_ID` block to keep the diff minimal.

**HTTP server handler (`AgentHookServer.start`, lines 80-116)** — read `toolUseId` from the query string:

```ts
const toolUseId = url.searchParams.get("toolUseId");
```

**Relay function signature** — extend both the `setRelay` parameter type and the private `relayFn` field to take `toolUseId: string | null` as a 6th argument, after `eventType`. Pass it through when calling `this.relayFn?.(...)`.

Update the `console.debug` line that logs hook HTTP arrival to include `toolUseId`.

### `electron/app-lifecycle.ts`

**`SessionState` interface (lines 316-319)**:

```ts
interface SessionState {
  activeSubagents: Set<string>;   // replaces subagentCount
  hasBeenActive: boolean;
}
```

**`getOrCreateSessionState`** — initialize `activeSubagents: new Set()` instead of `subagentCount: 0`.

**Relay callback signature (line 361)** — add `toolUseId` as the 6th param:

```ts
agentHookServer.setRelay((paneId, status, kind, sessionId, eventType, toolUseId) => {
```

**Subagent event handling (lines 407-414)**:

```ts
if (eventType === "SubagentStart") {
  const id = toolUseId ?? `__fallback_${sessionState.activeSubagents.size}`;
  sessionState.activeSubagents.add(id);
} else if (eventType === "SubagentStop") {
  if (toolUseId) {
    sessionState.activeSubagents.delete(toolUseId);
  } else {
    // Fallback: no id available — remove any one entry (prefer a fallback entry if present)
    const first = sessionState.activeSubagents.values().next().value;
    if (first !== undefined) sessionState.activeSubagents.delete(first);
  }
}
```

**Stop gate (line 483)**:

```ts
if (sessionState.activeSubagents.size > 0) {
  return;
}
```

Leave the `SessionEnd` / `StopFailure` branches unchanged; they already don't consult the subagent count.

### `electron/agent-hooks.ts` test imports (if any reference the relay signature)

Search for other callers of `setRelay` (tests) and add `toolUseId` arg as `null` where appropriate — the existing `agent-hooks.test.ts` may construct relay fns. Keep existing behavior for non-subagent events.

## Verification

- `npm run typecheck` passes.
- `npm run build` passes.
- Existing tests in `electron/__tests__/agent-hooks.test.ts` still pass (fix them to pass `toolUseId: null` if needed).

## Out of scope

- The stale-Stop safety net (ticket 2).
- New unit tests for Set behavior (ticket 3).

## REQUIRED: Commit your work

When your implementation is complete, you MUST create a git commit. This is not optional.

Run:
  git add -A
  git commit -m "feat(adr-130): extract tool_use_id and track subagents as a Set"

Do not push.
