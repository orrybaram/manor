---
title: Phone E2E for background tasks
status: done
priority: medium
assignee: sonnet
blocked_by: [4]
---

# Phone E2E for background tasks

ADR-224. Extend the fake agent so its transcript contains a background agent,
then assert the phone flow end to end. **Do not run Playwright yourself.**
Write the spec, then run `pnpm typecheck` and eslint on the touched files. The
orchestrator runs the spec.

1. `tests/e2e/helpers/fake-agent-transcript.sh` / `fake-agent.ts`: add a
   scenario that writes:
   - an `Agent` tool_use with `run_in_background: true`
   - the async `tool_result` line, with top-level `toolUseResult: {isAsync:
     true, status: "async_launched", agentId: "afake01"}`
   - lines to `<dir>/<session>/subagents/agent-afake01.jsonl`, with
     `isSidechain: true`, a user prompt and an assistant reply
   - then a `<task-notification>` user line with the matching
     `<tool-use-id>` and `<status>completed</status>`
   Follow how `tests/e2e/phone-chat.spec.ts` drives the existing fake
   transcript.
2. `tests/e2e/phone-chat.spec.ts`, new test:
   - the card shows running, with the "1 running" chip
   - tap → the sheet shows the subagent's reply
   - after the notification, the card shows ok and the summary, the chip is
     gone, and there's no separate `chat-notice`.

## Files to touch
- `tests/e2e/helpers/fake-agent-transcript.sh`, `tests/e2e/helpers/fake-agent.ts`
- `tests/e2e/phone-chat.spec.ts`
