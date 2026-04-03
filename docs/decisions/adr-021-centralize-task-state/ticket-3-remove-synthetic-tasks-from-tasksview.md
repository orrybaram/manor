---
title: Remove synthetic task merging from TasksView
status: done
priority: critical
assignee: sonnet
blocked_by: [1]
---

# Remove synthetic task merging from TasksView

`TasksView.tsx` currently merges persisted tasks with synthetic `TaskInfo` objects derived from `useAllAgents()`. Since ticket-1 ensures tasks are created and named in the main process on the first active hook event, there's no need for synthetic entries.

## Implementation

### 1. Remove merge logic from `TasksView.tsx`

Delete the `mergedTasks` useMemo block (lines 140-175) and replace with direct use of tasks from the store:

```typescript
const { tasks, loading, loaded, loadMoreTasks } = useTaskStore();
```

Use `tasks` directly where `mergedTasks` was used (in the filter/group logic below).

### 2. Remove imports

- Remove `import { useAllAgents } from "../hooks/useAllAgents";`
- Remove the `liveAgents` variable

### 3. Remove `cleanTitle` function

Delete the `cleanTitle` helper function (lines 76-88) — it's no longer needed since the main process handles title cleaning.

### 4. Update task name display

The `TaskRow` component already shows `task.name || "Untitled Session"`. Consider changing the fallback to just `"Agent"` for consistency, or keep `"Untitled Session"` — either way, it will never show `"claude"`.

## Files to touch
- `src/components/TasksView.tsx` — remove merge logic, `cleanTitle`, `useAllAgents` import
