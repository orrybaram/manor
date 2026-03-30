---
title: Add view mode toggle and wire TasksView into App
status: done
priority: high
assignee: sonnet
blocked_by: [6]
---

# Add view mode toggle and wire TasksView into App

Integrate the TasksView into App.tsx with a view mode state, and add navigation from the sidebar.

## Files to touch

- `src/App.tsx` — Changes:
  1. Add state: `const [viewMode, setViewMode] = useState<"terminal" | "tasks">("terminal")`
  2. In the `terminal-container` div, conditionally render:
     - If `viewMode === "tasks"`: render `<TasksView onResumeTask={handleResumeTask} />`
     - Otherwise: render the existing terminal sessions (current code)
  3. Add `handleResumeTask(task: TaskInfo)` function:
     - Switch to the task's workspace: `setActiveWorkspace(task.workspacePath)`
     - Add a new session: `addSession()`
     - Switch back to terminal mode: `setViewMode("terminal")`
     - After a short delay (to let the PTY initialize), write the resume command to the focused pane: `window.electronAPI.pty.write(paneId, "claude --resume " + task.claudeSessionId + "\r")`
  4. Pass `setViewMode` down to Sidebar (or use a shared store/context)

- `src/components/Sidebar.tsx` — Add a "Tasks" section below projects (or above Ports):
  - A section header row with a list icon and "Tasks" label
  - Click sets `viewMode` to "tasks"
  - Show active task count badge (from task store, filtered by status === "active")

## Implementation notes

- The resume flow needs a brief delay between `addSession()` and writing to the new pane because the PTY needs to be created first. Use `requestAnimationFrame` or a small `setTimeout(100)`.
- For the `setViewMode` communication between App and Sidebar, simplest approach is to pass it as a prop through the component tree. Alternatively, add `viewMode`/`setViewMode` to the project store since it already manages sidebar state.
- Keep the existing empty states (`WelcomeEmptyState`, `WorkspaceEmptyState`) — they only show when `viewMode === "terminal"` and no sessions exist.
- The existing keybinding handler in App.tsx may want a shortcut to toggle tasks view (optional, could be added later).
