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

# ADR-022: Fix subagent task persistence

## Context

When Claude Code spawns subagents (via the Agent tool), each subagent gets its own `session_id` and fires its own hook events (`PreToolUse`, `PostToolUse`, `Stop`, etc.) on the same pane as the parent. The current relay logic in `electron/main.ts` treats every unique `session_id` as a new top-level task, creating persisted `TaskInfo` entries for subagents.

This results in subagent sessions appearing as separate top-level tasks in the sidebar/task list, polluting the task history with ephemeral work items that should never be persisted.

The parent session already handles subagent lifecycle via `SubagentStart`/`SubagentStop` events and the `subagentCount` tracking in `SessionState`. The missing piece is identifying when hook events come from a *subagent's own session* (as opposed to the parent session reporting subagent start/stop).

## Decision

Track the "root session" per pane. The first `session_id` seen on a given pane is the root (parent) session. Any subsequent *different* `session_id` on the same pane is a subagent session.

Changes in `electron/main.ts`:

1. **Add a `paneRootSession` map** (`Map<string, string>`) — maps `paneId → rootSessionId`.
2. **In the relay callback**, before task persistence logic:
   - If no root session is recorded for this pane, record `sessionId` as the root.
   - If a root session exists and the incoming `sessionId` differs, this is a subagent — relay the hook to `AgentDetector` (for status display) but **skip all task persistence**.
   - On `SessionEnd` for the root session, clean up the pane's root session entry.
3. **No changes to `TaskInfo`, `TaskManager`, or the frontend** — subagent sessions simply never create tasks.

This approach is minimal and correct:
- The first session on a pane is always the user-initiated agent (root).
- Subagents always run in the same pane as their parent.
- No changes to the hook script or payload parsing needed.

## Consequences

- **Positive**: Task list only contains user-initiated agent sessions. No more subagent pollution.
- **Positive**: Minimal change — only the relay callback in main.ts needs modification.
- **Limitation**: Subagent activity is not shown nested under the parent task in the UI. This is acceptable for now — the parent task stays "active" while subagents run (existing `subagentCount` logic handles this).
- **Edge case**: If a pane is reused for a completely new agent session (user starts a new Claude session after the first ends), the `SessionEnd` cleanup ensures the new session becomes the root.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
