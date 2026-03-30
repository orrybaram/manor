---
title: Create TasksView main content component
status: done
priority: high
assignee: opus
blocked_by: [4]
---

# Create TasksView main content component

New main content view that shows all historical tasks, grouped by date and project.

## Files to touch

- `src/components/TasksView.tsx` (NEW) — Main component:
  - Load tasks from `useTaskStore` on mount
  - Group tasks by date buckets: "Today", "Yesterday", "This Week", "This Month", "Older"
  - Within each date bucket, sub-group by `projectName` (null → "No Project")
  - Each task row renders:
    - `AgentDot` component (reuse from `src/components/AgentDot.tsx`) with `task.lastAgentStatus` or mapped from `task.status`
    - Task name (fallback to "Untitled Session" if null)
    - Project/workspace label (dimmed)
    - Relative timestamp (e.g., "2h ago", "Mar 15")
  - Click handler: calls `onResumeTask(task)` prop
  - "Load more" button at bottom when there are more tasks (tracks offset in local state, calls `loadMoreTasks`)
  - Optional status filter tabs at top: All | Active | Completed

- `src/components/TasksView.module.css` (NEW) — Styles following existing CSS module patterns:
  - Use existing CSS variables: `--dim`, `--surface`, `--text-primary`, `--text-dim`, `--text-selected`, `--accent`, `--border`
  - Date group headers similar to `.sectionHeader` in Sidebar.module.css
  - Task rows similar to `.agentItem` style
  - Project sub-group headers similar to `.taskGroupHeader`

## Implementation notes

- Date grouping helper: compare `task.createdAt` to `new Date()` for bucket assignment
- Reuse `AgentDot` component for status indicators — map task status to AgentStatus:
  - "active" → "working"
  - "completed" → "complete" (already supported by AgentDot)
  - "error" → "error"
  - "abandoned" → "idle"
- If `task.lastAgentStatus` exists and task is active, prefer that for a more granular indicator
- Keep component performant — tasks list could be long. Use `React.memo` on task rows.
