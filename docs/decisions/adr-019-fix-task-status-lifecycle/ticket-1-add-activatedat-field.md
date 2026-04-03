---
title: Add activatedAt field to TaskInfo
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Add activatedAt field to TaskInfo

Add an `activatedAt: string | null` field to `TaskInfo` to track whether a task has ever been genuinely active (received a thinking/working/requires_input event).

## Files to touch

- `electron/task-persistence.ts` — Add `activatedAt: string | null` to the `TaskInfo` interface (after `completedAt`). Default to `null` in `createTask`.
- `src/electron.d.ts` — Add `activatedAt: string | null` to the `TaskInfo` type definition to match.
