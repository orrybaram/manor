---
title: Remove useAllAgents if no longer used
status: done
priority: low
assignee: haiku
blocked_by: [2, 3]
---

# Remove useAllAgents if no longer used

After tickets 2 and 3, `useAllAgents` may have no remaining consumers. Check and clean up.

## Implementation

1. Search for all imports of `useAllAgents` across the codebase
2. If there are zero remaining consumers, delete `src/hooks/useAllAgents.ts`
3. If there are still consumers (e.g., for aggregate agent dot indicators), leave the file in place

Note: `useProjectAgentStatus` and `useSessionAgentStatus` read from `paneAgentStatus` directly — they do NOT use `useAllAgents`, so they are unaffected.

## Files to touch
- `src/hooks/useAllAgents.ts` — delete if unused
