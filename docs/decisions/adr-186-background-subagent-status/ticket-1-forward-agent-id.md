---
title: Forward agent_id from the hook script and parse it on every event
status: todo
priority: high
assignee: sonnet
blocked_by: []
---

# Forward agent_id from the hook script and parse it on every event

See ADR-186 §1. Claude Code's hook payloads carry `agent_id` on every hook a
subagent sends (SubagentStart, SubagentStop, and the subagent's own
PreToolUse / PostToolUse / PermissionRequest …). The root session's own hooks
have no `agent_id`. SubagentStart / SubagentStop have **no** `tool_use_id`.

## Changes

- `electron/scripts/agent-hook.js`: read
  `typeof payload.agent_id === "string" ? payload.agent_id : null` next to
  `toolUseId`, pass it to `buildUrl`, and set the `agentId` query param when
  present. Keep the file plain JS; match the existing style.
- `electron/agent-hook-events.ts`: add `agentId: string | null` to
  `EventBase` (read `params.get("agentId")`), so every variant carries it.
  Keep `toolUseId` on the Subagent variants as-is.
- Fix any compile errors from the new required field (test fixtures that
  build `AgentHookEvent` literals: add `agentId: null`, or use an existing
  helper/factory if tests have one).

## Tests
- `electron/__tests__/agent-hook-script.test.ts`: payload with `agent_id`
  → URL has `agentId`; without it → no `agentId` param.
- Parser tests (find with `rtk proxy grep -rn parseAgentHookEvent electron`):
  `agentId` parsed for SubagentStart and PreToolUse; null when absent.

## Files to touch
- `electron/scripts/agent-hook.js`
- `electron/agent-hook-events.ts`
- `electron/__tests__/agent-hook-script.test.ts`
- parser tests / fixtures that construct `AgentHookEvent`
