---
title: Add responded and complete toast notifications
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Add responded and complete toast notifications

In `src/store/task-store.ts`, inside `receiveTaskUpdate`, add toast notifications for `responded` and `complete` statuses when the task pane is not already visible. Follow the existing pattern used for `requires_input`.

## Changes

After the existing `requires_input` toast block (line ~155), add:

```typescript
if (nextStatus === "responded") {
  if (!isAlreadyVisible) {
    const toastId = `task-responded-${task.id}`;
    useToastStore.getState().addToast({
      id: toastId,
      message: "Task responded",
      detail: task.name || "Agent",
      status: "success",
      action: {
        label: "Go to task",
        onClick: () => {
          navigateToTask(task);
          useToastStore.getState().removeToast(toastId);
        },
      },
    });
  }
}

if (nextStatus === "complete") {
  if (!isAlreadyVisible) {
    const toastId = `task-complete-${task.id}`;
    useToastStore.getState().addToast({
      id: toastId,
      message: "Task completed",
      detail: task.name || "Agent",
      status: "success",
      action: {
        label: "Go to task",
        onClick: () => {
          navigateToTask(task);
          useToastStore.getState().removeToast(toastId);
        },
      },
    });
  }
}
```

## Files to touch
- `src/store/task-store.ts` — add toast triggers for `responded` and `complete` statuses in `receiveTaskUpdate`
