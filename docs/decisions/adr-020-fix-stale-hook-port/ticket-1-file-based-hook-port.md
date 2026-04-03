---
title: Switch hook port discovery from env var to file
status: done
priority: critical
assignee: sonnet
blocked_by: []
---

# Switch hook port discovery from env var to file

Write the hook port to `~/.manor/hook-port` on server start. Update the hook script template to read from this file with `$MANOR_HOOK_PORT` as fallback. Clean up the file on stop.

## Files to touch

- `electron/agent-hooks.ts`
