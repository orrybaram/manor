---
title: Extract cleanAgentTitle to shared renderer utility
status: done
priority: high
assignee: haiku
blocked_by: []
---

# Extract cleanAgentTitle to shared renderer utility

Create a renderer-side copy of `cleanAgentTitle` so the `useTaskDisplay` hook can use it.

## What to do

1. Create `src/utils/agent-title.ts` with the same logic as `electron/title-utils.ts`:
   - Copy the `GENERIC_AGENT_TITLES` set and `cleanAgentTitle` function
   - Export `cleanAgentTitle`

2. The function is pure (no Node deps), so a direct copy works. The existing `electron/title-utils.ts` stays unchanged (main process still imports from there).

## Files to touch
- `src/utils/agent-title.ts` — **create** with `cleanAgentTitle` function (copy from `electron/title-utils.ts`)
