---
title: Add dock badge count for responded agents
status: todo
priority: high
assignee: sonnet
blocked_by: [1]
---

# Add dock badge count for responded agents

Wire the dock badge to update whenever task state changes.

## Implementation

In `electron/main.ts`, add a `updateDockBadge()` function:

1. Check `preferencesManager.get("dockBadgeEnabled")` — if false, ensure badge is cleared and return.
2. Get all tasks from `taskManager.getAllTasks()`.
3. Count tasks where `status === "active"` AND `lastAgentStatus === "responded"`.
4. Call `app.dock?.setBadge(count > 0 ? count.toString() : "")`.

Call `updateDockBadge()`:
- Inside the existing `broadcastTask()` function (after sending to renderer)
- On preferences change (when user toggles the setting)

Clear badge on window focus:
- Add `mainWindow.on("focus", () => ...)` — but only clear if there are no responded tasks. Actually, don't auto-clear on focus. The badge should persist until the agent status changes (e.g., user sends a new message, making the agent active again).

## Files to touch
- `electron/main.ts` — add updateDockBadge function, call it from broadcastTask and on preference change
