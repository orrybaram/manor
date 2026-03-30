---
title: Fix X button click handler to also remove task
status: done
priority: high
assignee: haiku
blocked_by: []
---

# Fix X button click handler to also remove task

In `src/components/TasksList.tsx`, update the X button's `onClick` handler (around line 186) so that `removeTask` is always called, not only when the task has no `paneId`.

## Files to touch
- `src/components/TasksList.tsx` — Change the if/else to: close pane if exists, then always remove task
