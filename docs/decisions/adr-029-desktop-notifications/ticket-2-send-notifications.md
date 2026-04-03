---
title: Send native notifications from main process
status: done
priority: critical
assignee: sonnet
blocked_by: [1]
---

# Send native notifications from main process

Wire up Electron's `Notification` API in `electron/main.ts` to fire desktop notifications on agent status transitions.

## Implementation details

- Import `Notification` from `electron` at the top of `main.ts`
- In the `broadcastTask()` function (or immediately after the relay callback updates a task), compare previous `lastAgentStatus` to new status
- Track previous status: before calling `taskManager.updateTask()`, read the existing task's `lastAgentStatus`. Pass old+new status to a `maybeSendNotification()` helper
- `maybeSendNotification(task, prevStatus, newStatus)` logic:
  1. If `mainWindow.isFocused()` → return (skip when app is focused)
  2. If `newStatus === "responded"` and `prevStatus !== "responded"` and `preferencesManager.get("notifyOnResponse")` → send notification
  3. If `newStatus === "requires_input"` and `prevStatus !== "requires_input"` and `preferencesManager.get("notifyOnRequiresInput")` → send notification
  4. Otherwise → return
- Create the notification:
  ```ts
  const notification = new Notification({
    title: newStatus === "responded" ? "Agent responded" : "Agent needs input",
    body: [task.name || "Agent", task.projectName].filter(Boolean).join(" — "),
    silent: !preferencesManager.get("notificationSound"),
  });
  notification.on("click", () => {
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send("notification:navigate-to-task", task.id);
  });
  notification.show();
  ```

## Files to touch

- `electron/main.ts` — Add `Notification` import, add `maybeSendNotification()` helper, call it from the relay callback after task updates
- `electron/preload.ts` — Add `notifications: { onNavigateToTask: (cb) => onChannel("notification:navigate-to-task", cb) }` to the exposed API
- `src/electron.d.ts` — Add type for the new `notifications` namespace in `ElectronAPI` if typed
