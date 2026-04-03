---
title: Update main process badge logic with unseen tracking
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Update main process badge logic with unseen tracking

Refactor `updateDockBadge()` and the relay handler in `electron/main.ts` to support dot vs count badge and track unseen tasks.

## Files to touch
- `electron/main.ts` — all changes
