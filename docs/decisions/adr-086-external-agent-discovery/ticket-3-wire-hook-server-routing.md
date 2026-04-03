---
title: Wire hook server to route external events to ExternalSessionManager
status: done
priority: high
assignee: sonnet
blocked_by: [1, 2]
---

# Wire hook server to route external events to ExternalSessionManager

Connect the existing hook relay in `main.ts` to the new `ExternalSessionManager` so external hook events are handled properly.

## Files to touch
- `electron/main.ts` — Import ExternalSessionManager, instantiate it, wire into relay callback, add routing logic for `external:` pane IDs, lifecycle management
