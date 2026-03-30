---
title: Add right-click context menu to add tab button
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Add right-click context menu to add tab button

Add a context menu (right-click) to the "New Tab" add button in the tab bar with two options: "Browser" and "Task".

## Files to touch
- `src/App.tsx` — pass `onNewTask` prop to TabBar
- `src/components/TabBar.tsx` — add context menu with Browser and Task options
