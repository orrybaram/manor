---
title: Add agent status indicator to collapsed project headers
status: done
priority: medium
assignee: sonnet
blocked_by: []
---

# Add agent status indicator to collapsed project headers

Create a hook to aggregate agent status across all workspaces in a project, then render an `AgentDot` in the collapsed project header.

## Implementation

### 1. Create `src/hooks/useProjectAgentStatus.ts`

- Hook: `useProjectAgentStatus(project: ProjectInfo): AgentStatus | null`
- Subscribe to `useAppStore` selectors: `workspaceSessions` and `paneAgentStatus`
- For each workspace path in `project.workspaces`, iterate sessions → panes → check `paneAgentStatus[paneId]`
- Use `STATUS_PRIORITY` from `useSessionAgentStatus.ts` to find highest-priority non-idle status
- Return the best status, or `null` if no active agents

### 2. Update `src/components/ProjectItem.tsx`

- Import the new hook
- Call `useProjectAgentStatus(project)` in `ProjectItem`
- In the project header div, between the project name `<span>` and the `<button>` for "+", conditionally render:
  ```tsx
  {collapsed && projectStatus && (
    <AgentDot status={projectStatus} size="sidebar" />
  )}
  ```

## Files to touch
- `src/hooks/useProjectAgentStatus.ts` — new file, ~30 lines
- `src/components/ProjectItem.tsx` — import hook, call it, render dot conditionally
