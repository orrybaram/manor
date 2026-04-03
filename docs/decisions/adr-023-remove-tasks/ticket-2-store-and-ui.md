---
title: Add removeTask to store and delete button to TasksView UI
status: todo
priority: high
assignee: sonnet
blocked_by: [1]
---

# Add removeTask to store and delete button to TasksView UI

Wire up the frontend to support task deletion.

## Implementation

### 1. `src/store/task-store.ts` — Add `removeTask` action

Add to the `TaskState` interface:

```typescript
removeTask: (taskId: string) => Promise<void>;
```

Implementation:

```typescript
removeTask: async (taskId: string) => {
  const success = await window.electronAPI.tasks.delete(taskId);
  if (success) {
    set((s) => ({
      tasks: s.tasks.filter((t) => t.id !== taskId),
    }));
  }
},
```

### 2. `src/components/TasksView.tsx` — Add remove button to TaskRow

- Import `X` from lucide-react (already imported for close button)
- Add `onRemoveTask` callback prop to `TaskRowProps`
- Add a remove button that appears on hover, positioned at the end of the row
- Only show the remove button for non-active tasks (`task.status !== "active"`)
- The button should call `e.stopPropagation()` to prevent triggering the row click (resume)
- In `TasksModal`, get `removeTask` from `useTaskStore()` and pass it to `TaskRow`

### 3. `src/components/TasksView.module.css` — Style the remove button

- `.removeButton` — hidden by default, appears on `.taskRow:hover`
- Small, subtle X button matching the existing close button style
- Position it after the time column

## Files to touch
- `src/store/task-store.ts` — add `removeTask` action
- `src/components/TasksView.tsx` — add remove button to `TaskRow`, wire up in `TasksModal`
- `src/components/TasksView.module.css` — add `.removeButton` styles
