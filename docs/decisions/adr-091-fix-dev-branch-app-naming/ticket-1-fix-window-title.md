---
title: Set BrowserWindow title to include branch name in dev mode
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Set BrowserWindow title to include branch name in dev mode

Move the branch detection before `createWindow()` so the branch is available, then after window creation set the title and prevent HTML override.

## Files to touch
- `electron/main.ts` — After `createWindow()`, call `mainWindow.setTitle()` with the branch-suffixed name, and add a `page-title-updated` event handler that calls `preventDefault()` to stop the HTML `<title>` from overriding it
