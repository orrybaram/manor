---
title: Wire TasksList to use useTaskDisplay hook
status: todo
priority: critical
assignee: sonnet
blocked_by: [2]
---

# Wire TasksList to use useTaskDisplay hook

Update `TasksList.tsx` to use the new `useTaskDisplay` hook instead of its inline `taskAgentStatus()` function and raw `task.name`.

## What to do

1. Remove the `taskAgentStatus()` function from `TasksList.tsx` (lines 12-23).

2. Extract each task row into a small `TaskRow` component (required because hooks can't be called inside `.map()`):

```typescript
function TaskRow({ task, shouldPulse, onClose, onClick }: {
  task: TaskInfo;
  shouldPulse: boolean;
  onClose: () => void;
  onClick: () => void;
}) {
  const { title, status } = useTaskDisplay(task);
  return (
    <button className={styles.agentItem} onClick={onClick}>
      <AgentDot status={status} size="sidebar" pulse={shouldPulse} />
      <span className={styles.agentName}>{title}</span>
      <span className={styles.taskClose} onClick={(e) => { e.stopPropagation(); onClose(); }} title="Close task">
        <X size={12} />
      </span>
    </button>
  );
}
```

3. Update the main `TasksList` component to render `<TaskRow>` instead of the inline JSX.

4. Import `useTaskDisplay` from `../../hooks/useTaskDisplay`.

5. Remove the now-unused `AgentStatus` import from `../../electron.d` if no longer needed directly.

## Files to touch
- `src/components/sidebar/TasksList.tsx` — remove `taskAgentStatus`, extract `TaskRow` component, use `useTaskDisplay`
