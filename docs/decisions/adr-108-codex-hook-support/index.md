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

# ADR-108: Codex Hook Support for Agent Status & Tasks

## Context

Manor already has a robust agent lifecycle tracking system built around Claude Code's hook system. The `AgentHookServer` receives HTTP events from a shell script (`~/.manor/hooks/notify.sh`), maps them to `AgentStatus` values, and pipes them through to the renderer for status dots, task persistence, notifications, and dock badges.

The `CodexConnector` exists but is a stub — `registerHooks()` and `registerMcp()` are no-ops. Codex CLI now supports hooks via `~/.codex/hooks.json` with the same event-driven pattern as Claude Code. It supports these events: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`. The hooks.json format is structurally identical to Claude's settings.json hooks format. Codex writes the hook payload as JSON to stdin (same `hook_event_name` / `session_id` fields).

Without this, Codex users get no status indicators, no task tracking, and no notifications — the experience is broken.

## Decision

Wire up the `CodexConnector` to register Manor's hook script in `~/.codex/hooks.json`, mirroring how `ClaudeConnector` registers hooks in `~/.claude/settings.json`.

### Specifics

1. **`CodexConnector.registerHooks()`** — Read/write `~/.codex/hooks.json` to register the Manor notify script for all supported Codex events (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`). The file format is identical to Claude's hook format (event → matcher group → handler array).

2. **`mapEventToStatus()`** — Already handles most events. Add `SessionStart` → map it the same way `UserPromptSubmit` maps (to `"thinking"`), since it signals the agent is alive and processing.

3. **`CodexConnector.registerMcp()`** — Register the Manor MCP webview server in Codex's MCP config via `codex mcp add` CLI command or by editing config directly. Codex uses a different MCP registration mechanism than Claude.

4. **`CodexConnector.getResumeCommand()`** — Codex supports `codex resume` (picker) and `codex resume --last`. Wire up resume support.

5. **Codex hooks feature flag** — Codex requires `codex_hooks = true` in `~/.codex/config.toml`. The connector should ensure this flag is set when registering hooks.

## Consequences

**Better:**
- Codex users get full status tracking (dots, spinners, checkmarks)
- Task persistence works for Codex sessions
- Notifications and dock badges work for Codex
- MCP webview server available in Codex sessions

**Risks:**
- Codex hook events are a subset of Claude's (no `SubagentStart/Stop`, `PermissionRequest`, `Notification`, `PostToolUseFailure`, `StopFailure`, `SessionEnd`). Status detection will be less granular — no `requires_input` from hooks, no subagent tracking, no explicit session end signal. The existing fallback detection and process polling will cover some gaps.
- Writing to `~/.codex/config.toml` to enable the feature flag is more invasive than just adding hooks — we should only set it if not already set.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
