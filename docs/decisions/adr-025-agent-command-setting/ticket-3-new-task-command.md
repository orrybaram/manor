---
title: Add New Task command to command palette
status: todo
priority: high
assignee: sonnet
blocked_by: [1]
---

# Add New Task command to command palette

Add a "New Task" command in the Tasks group of the command palette. When selected, it creates a new session tab and runs the configured agent command in it.

## Files to touch
- `src/components/CommandPalette/types.ts` — add `onNewTask` callback to `CommandPaletteProps`
- `src/components/CommandPalette/useTaskCommands.tsx` — accept `onNewTask` param, add "New Task" command item at top of list with `Plus` icon
- `src/components/CommandPalette/CommandPalette.tsx` — destructure `onNewTask` from props, pass to `useTaskCommands`
- `src/App.tsx` — implement `handleNewTask`: find current project from active workspace path, get its `agentCommand` (default to `claude --dangerously-skip-permissions`), call `addSession()`, then after 150ms delay write the command to the focused pane. Also update `handleResumeTask` to use the project's `agentCommand` base instead of hardcoded `claude`. Pass `handleNewTask` to `CommandPalette`.
