---
title: Display external tasks in the sidebar UI
status: done
priority: high
assignee: sonnet
blocked_by: [2, 3]
---

# Display external tasks in the sidebar UI

Surface external agent sessions in the task sidebar with appropriate visual treatment.

## Files to touch
- `src/electron.d.ts` — Add `external` and `sourceApp` to TaskInfo type
- `src/store/task-store.ts` — Update notification toast to handle external tasks (paneId null)
- `src/components/TasksList.tsx` — Add external task grouping and rendering
- `src/utils/task-navigation.ts` — Handle external tasks gracefully (no pane to navigate to)
