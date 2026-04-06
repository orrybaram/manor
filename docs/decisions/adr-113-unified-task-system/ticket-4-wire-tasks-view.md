---
title: Wire TasksView to use useTaskDisplay hook
status: done
priority: high
assignee: sonnet
blocked_by: [2]
---

# Wire TasksView to use useTaskDisplay hook

Update `TasksView.tsx` to use the `useTaskDisplay` hook, removing its own duplicated `taskAgentStatus()`.

## What to do

1. Read `src/components/sidebar/TasksView/TasksView.tsx` fully first.

2. Remove the local `taskAgentStatus()` function.

3. Extract the task row rendering into a `TaskViewRow` component so the hook can be called per-task:

```typescript
function TaskViewRow({ task, onResume, onDelete }: { ... }) {
  const { title, status } = useTaskDisplay(task);
  // ... render with title and status instead of task.name and taskAgentStatus(task)
}
```

4. Update the parent to render `<TaskViewRow>` in the list.

5. Import `useTaskDisplay` from `../../../hooks/useTaskDisplay`.

## Files to touch
- `src/components/sidebar/TasksView/TasksView.tsx` — remove `taskAgentStatus`, extract row component, use `useTaskDisplay`
