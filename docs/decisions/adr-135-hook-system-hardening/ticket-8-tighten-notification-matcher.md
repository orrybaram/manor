---
title: Tighten Notification matcher so generic notifications don't flip status
status: todo
priority: medium
assignee: sonnet
blocked_by: [5]
---

# Tighten Notification matcher so generic notifications don't flip status

`ClaudeConnector.registerHooks` (`electron/agent-connectors.ts:57`) registers Notification with matcher `"permission_prompt"`. `mapEventToStatus` (`electron/agent-hooks.ts:35`) flips any Notification event to `requires_input`. If Claude Code's hook system fires Notification for non-permission reasons (auto-compact, generic info, future event additions), Manor will mark the task `requires_input` until something else clears it.

See ADR-135 §"Change 8" for context.

This ticket depends on ticket 5 (Node hook script) because robust payload introspection is hard to do from bash.

## What to change

1. **Pin down the schema.** Run a recent Claude Code build, fire a permission-style Notification, fire a non-permission one (auto-compact is easy to reproduce on a long thread), and capture both payloads. Identify the field that distinguishes them — likely a `notification` sub-object with a `type` or `kind` string.
2. In `electron/scripts/agent-hook.js` (from ticket 5), extract the discriminating field if present and forward it as `notification_kind` query param.
3. In `electron/agent-hooks.ts` request handler, read `notification_kind` and only proceed for events where it indicates a permission-style notification. For everything else, return 200 with no relay call (or relay with status `null` / a no-op).
4. Update `electron/__tests__/` with a unit test that exercises both shapes.

If step 1 reveals that the matcher in `~/.claude/settings.json` is already authoritative (Claude only fires Notification with the configured matcher), the tightening shifts to the matcher string itself: confirm `permission_prompt` is correct or replace with the documented value.

## Files to touch

- `electron/scripts/agent-hook.js` — extract `notification_kind` if relevant.
- `electron/agent-hooks.ts` — gate Notification on `notification_kind`.
- Possibly `electron/agent-connectors.ts` — adjust the matcher string if Claude's docs disagree with the current registration.

## Notes

Schema verification first; coding second. If the schema turns out to be load-bearing on the matcher (and the matcher is correct), this ticket reduces to "add a unit test confirming behaviour". Either outcome is acceptable.
