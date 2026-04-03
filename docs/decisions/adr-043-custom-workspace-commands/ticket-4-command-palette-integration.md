---
title: Show custom commands in the command palette
status: todo
priority: high
assignee: sonnet
blocked_by: [1]
---

# Show custom commands in the command palette

Create a `useCustomCommands` hook and wire it into the command palette so custom commands appear in a "Run" group.

## Files to touch

- `src/components/CommandPalette/useCustomCommands.tsx` — New file. Create `useCustomCommands` hook that takes `{ onClose, activeWorkspacePath }`. It should: (1) find the active project by matching `activeWorkspacePath` to a project's workspaces using `useProjectStore`, (2) get the active pane ID from `useAppStore`, (3) return `CommandItem[]` mapping each `project.commands` entry to a command item where the action writes `command + "\r"` to the active pane via `window.electronAPI.pty.write(activePaneId, command + "\r")` then calls `onClose()`. Use a terminal icon from lucide-react (e.g. `Terminal`).
- `src/components/CommandPalette/CommandPalette.tsx` — Import and call `useCustomCommands`. Render its results as a `Command.Group` with heading "Run" in the root view, between the Tasks group and the workspace groups. Only render the group if there are commands to show.
