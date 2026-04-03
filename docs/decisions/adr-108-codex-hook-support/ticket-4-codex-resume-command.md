---
title: Wire up Codex resume command support
status: done
priority: low
assignee: haiku
blocked_by: []
---

# Wire up Codex resume command support

Implement `CodexConnector.getResumeCommand()` so Manor can resume existing Codex sessions.

## Implementation

Codex supports `codex resume --last` to resume the most recent session, and `codex resume` for a picker. Since Manor tracks session IDs, use `codex resume --last` as the resume command (Codex doesn't support resuming by session ID directly).

Update `getResumeCommand()` to return `"codex resume --last"` instead of `null`. Extract the binary name from the base command the same way `ClaudeConnector` does.

## Files to touch
- `electron/agent-connectors.ts` — Update `CodexConnector.getResumeCommand()` to return a resume command string.
