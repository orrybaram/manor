---
title: Extract navigateToTask and add task status toasts
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Extract navigateToTask and add task status toasts

## Steps

1. **Extract `navigateToTask`** from `src/components/TasksList.tsx` into `src/utils/task-navigation.ts` so it can be reused by the toast action.

2. **Update `TasksList.tsx`** to import `navigateToTask` from the new utility instead of defining it inline.

3. **Add toast notifications in `src/store/task-store.ts`**:
   - Import `useToastStore` from `../store/toast-store`
   - Import `navigateToTask` from `../utils/task-navigation`
   - In `receiveTaskUpdate`, before updating state, compare the old task's `lastAgentStatus` with the incoming task's `lastAgentStatus`
   - If `lastAgentStatus` changed to `"complete"`:
     ```ts
     useToastStore.getState().addToast({
       id: `task-done-${task.id}`,
       message: `Task completed: ${task.name || "Agent"}`,
       status: "success",
     });
     ```
   - If `lastAgentStatus` changed to `"requires_input"`:
     ```ts
     useToastStore.getState().addToast({
       id: `task-input-${task.id}`,
       message: `Task needs input: ${task.name || "Agent"}`,
       status: "loading",
       persistent: true,
       action: {
         label: "Go to task",
         onClick: () => navigateToTask(task),
       },
     });
     ```
   - Only fire the toast if there was a previous task state (i.e., `idx >= 0`) to avoid toasting on initial load

## Files to touch
- `src/utils/task-navigation.ts` — new file, extract `navigateToTask` from TasksList
- `src/components/TasksList.tsx` — import `navigateToTask` from utils instead of defining locally
- `src/store/task-store.ts` — add toast logic in `receiveTaskUpdate`
