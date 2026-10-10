---
title: Capture transcript_path from hooks onto AgentInfo
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Capture transcript_path from hooks onto AgentInfo

ADR-215 D2.

- `electron/scripts/agent-hook.js`: read `payload.transcript_path` (string or null), the same way `sessionId` is read. Pass it to `buildUrl` as `transcriptPath`, and include it in the query only when it's non-null. Update the existing tests for `buildUrl`/`main`.
- `electron/agent-hook-events.ts`: parse `transcriptPath` and put it on `EventBase` (`transcriptPath: string | null`). Update the parser tests.
- Remote hosts: find where remote daemon hook payloads are classified and forwarded (`classifyHookRequest`, `electron/backend/hook-feed.ts`). Make sure the param passes through untouched. It is just another query param.
- `electron/agent-persistence.ts`: add `transcriptPath: string | null` to `AgentInfo`. Records loaded without it default to `null`. Add a method or extend the update path so a hook event with a non-null `transcriptPath` sets it when it differs (latest wins). Trace where hook events update agents (the `relayFn` consumer of `AgentHookServer`) and wire it there.
- Make sure the renderer-facing agent type (`RendererAgentUpdate` in `electron/bridge/handlers/agents.ts`, and any `src/` mirror type) carries `transcriptPath`, so the phone can tell whether chat is available.

## Files to touch
- `electron/scripts/agent-hook.js` (+ its tests)
- `electron/agent-hook-events.ts` (+ tests)
- `electron/agent-persistence.ts` (+ tests)
- the hook-event → agent update site (find it)
- `electron/bridge/handlers/agents.ts`, and the renderer agent types in `src/` if separate
