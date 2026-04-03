---
title: Call markSeen from renderer on task navigation and visibility
status: done
priority: high
assignee: sonnet
blocked_by: [1, 2]
---

# Call markSeen from renderer on task navigation and visibility

## Files to touch
- `src/utils/task-navigation.ts` — add markSeen call at end of navigateToTask
- `src/store/task-store.ts` — add auto-mark-seen when task pane is already visible
