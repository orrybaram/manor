---
title: Validate agentKind, drop unknown values, inject MANOR_AGENT_KIND per connector
status: todo
priority: high
assignee: sonnet
blocked_by: []
---

# Validate agentKind, drop unknown values, inject MANOR_AGENT_KIND per connector

Two related defects:

1. `electron/agent-hooks.ts:100` coerces unknown kinds to `"claude"`:
   ```ts
   const kind = (url.searchParams.get("kind") ?? "claude") as AgentKind;
   ```
   A hook with no `kind` parameter (or a typo) silently mislabels the task.
2. The bash hook script reads `MANOR_AGENT_KIND` from the spawning shell's env (`agent-hooks.ts:180`) and falls back to `"claude"`. Nothing in Manor explicitly injects `MANOR_AGENT_KIND` for any connector; the fallback is the only path. Codex and Pi hooks rely on this default — Pi's TS hook hard-codes `kind: "pi"` in its URL build (`agent-connectors.ts:395`) so it's fine. Codex via the bash script is mislabelled.

See ADR-135 §"Change 7" for full reasoning.

## What to change

### Server-side

In `electron/agent-hooks.ts` request handler:

```ts
const KNOWN_KINDS: ReadonlySet<string> = new Set(["claude", "codex", "opencode", "pi"]);

const rawKind = url.searchParams.get("kind");
if (!rawKind || !KNOWN_KINDS.has(rawKind)) {
  console.warn(
    `[agent-hooks] dropping hook with unknown kind=${rawKind} paneId=${paneId} event=${eventType}`,
  );
  res.writeHead(400);
  res.end();
  return;
}
const kind = rawKind as AgentKind;
```

Source `KNOWN_KINDS` from `getAllConnectors().map(c => c.kind)` rather than hard-coding — single source of truth.

### Spawn-side

For PTY sessions launched from a connector context, set `MANOR_AGENT_KIND` in the env passed to `pty:create` (or to the prewarm session). Where the spawn is connector-aware, derive from `connector.kind`. Where the spawn is generic (user typed `claude` themselves into a free shell), keep the current bash-script default of `claude` — that's the right answer for generic shells.

Audit the spawn paths:
- `prewarm-manager.ts:34` — uses `client.createNoSubscribe(...)`. Trace which connector fed the agent command in via `prewarm.warm(cwd, agentCommand)` and propagate kind.
- `electron/ipc/pty.ts:create` — accepts cwd/cols/rows; consider extending the IPC payload with optional `agentKind` and threading through to the daemon's PTY env.
- The daemon's PTY spawn (`electron/terminal-host/session.ts`) — needs to accept an env override map.

Concretely:
- Extend `pty:create` IPC signature to accept `{ env?: Record<string, string> }`.
- In `app-store.ts` (renderer), when creating a pane for a known connector, pass `{ MANOR_AGENT_KIND: kind }`.
- In `prewarm-manager`, accept a `kind` alongside `agentCommand` and pass it through.

## Files to touch

- `electron/agent-hooks.ts` — add validation; drop the silent coerce.
- `electron/agent-connectors.ts` — expose a registry helper if not present (e.g. `getAllAgentKinds(): AgentKind[]`).
- `electron/ipc/pty.ts` — accept optional env in `pty:create`.
- `electron/terminal-host/session.ts` (or wherever the PTY env is composed) — merge the optional env on top of the inherited env.
- `electron/prewarm-manager.ts` — accept `kind`, set `MANOR_AGENT_KIND` in the spawn env.
- Renderer call sites that originate connector-aware spawns — pass the kind.

## Tests

Unit:
1. Hook server with `kind=banana` returns 400 and does not invoke the relay.
2. Hook server with no `kind` parameter returns 400.
3. Hook server with `kind=codex` invokes relay with `kind: "codex"`.

Integration (smoke): spawn a Codex pane via the prewarm path; first hook event hits the server with `kind=codex`; resulting task has `agentKind: "codex"`.

## Notes

Sonnet-assigned because the IPC + env threading is moderate. If the spawn-side audit turns up more callers than expected, escalate to opus.
