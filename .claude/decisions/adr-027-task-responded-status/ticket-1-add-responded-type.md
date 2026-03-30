---
title: Add "responded" to AgentStatus type
status: done
priority: critical
assignee: haiku
blocked_by: []
---

# Add "responded" to AgentStatus type

Add `"responded"` to the `AgentStatus` union type in both type definition files.

## Files to touch
- `electron/terminal-host/types.ts` — Add `"responded"` to the `AgentStatus` type union (line 76)
- `src/electron.d.ts` — If `AgentStatus` is re-exported or duplicated here, add it there too. Currently `lastAgentStatus` is typed as `string | null` so no change needed there, but check if there's a separate `AgentStatus` export.
