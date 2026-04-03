---
title: Register Manor hooks in Codex hooks.json
status: done
priority: critical
assignee: sonnet
blocked_by: []
---

# Register Manor hooks in Codex hooks.json

Implement `CodexConnector.registerHooks()` to write Manor's notify script into `~/.codex/hooks.json`.

## Implementation

The hooks.json format is identical to Claude's settings.json hooks format:

```json
{
  "hooks": {
    "EventName": [
      {
        "hooks": [
          { "type": "command", "command": "/path/to/notify.sh" }
        ]
      }
    ]
  }
}
```

Register the Manor hook script for these Codex-supported events:
- `SessionStart`
- `UserPromptSubmit`
- `PreToolUse`
- `PostToolUse`
- `Stop`

Follow the same pattern as `ClaudeConnector.registerHooks()`:
1. Read existing `~/.codex/hooks.json` (or start with empty object)
2. For each event, check if the hook script is already registered
3. If not, append it
4. Write back if modified

Also ensure the `codex_hooks` feature flag is enabled in `~/.codex/config.toml`. Read the file, check if `codex_hooks = true` exists under `[features]`, and add it if missing. Use a simple line-based approach since TOML parsing isn't available — append `codex_hooks = true` under the `[features]` section if not present.

## Files to touch
- `electron/agent-connectors.ts` — Replace the no-op `CodexConnector.registerHooks()` with real implementation. Add `CODEX_HOOK_ENTRIES` array similar to `CLAUDE_HOOK_ENTRIES`.
