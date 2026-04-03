---
title: Rewrite TasksList to use task store instead of useAllAgents
status: done
priority: critical
assignee: sonnet
blocked_by: [1]
---

# Rewrite TasksList to use task store instead of useAllAgents

The sidebar `TasksList` currently renders directly from `useAllAgents()` (which derives from `paneAgentStatus` in `useAppStore`). This creates a separate rendering path from `TasksView`, with its own title-cleaning logic and the `agent.kind` fallback that causes the "claude" name bug.

Change it to read from `useTaskStore` filtered to active tasks.

## Implementation

### 1. Rewrite `src/components/TasksList.tsx`

Replace the data source:

**Before:**
```typescript
const agents = useAllAgents();
// groups by projectName from GlobalAgent
// renders: cleanAgentTitle(a.agent.title) || a.agent.kind || "Agent"
```

**After:**
```typescript
const { tasks } = useTaskStore();
const activeTasks = useMemo(
  () => tasks.filter((t) => t.status === "active"),
  [tasks],
);
```

Group by `task.projectName` instead of `agent.projectName`.

### 2. Update rendering

Each task row should render:
- `AgentDot` using `mapTaskStatusToAgentStatus(task)` (same helper from TasksView — move to a shared location or inline)
- Name: `task.name || "Agent"` — no title cleaning needed, the main process already cleaned and persisted it
- Status label: from `task.lastAgentStatus` using the existing `STATUS_LABEL` map

### 3. Update navigation

Replace `navigateToAgent(agent: GlobalAgent)` with navigation using `TaskInfo` fields:
- Use `task.paneId` to focus the pane
- Use `task.workspacePath` to set active workspace
- Look up the project by `task.projectId` to select it

The navigation function should:
1. Find the project in `useProjectStore` by `task.projectId`
2. Find the workspace by `task.workspacePath`
3. Find the session containing `task.paneId`
4. Call `selectProject`, `setProjectExpanded`, `selectWorkspace`, `setActiveWorkspace`, `selectSession`, `focusPane`

### 4. Remove `cleanAgentTitle` function

Delete the duplicate `cleanAgentTitle` function from this file — it's no longer needed.

### 5. Remove `useAllAgents` import

If this was the only consumer, note that `useAllAgents` is also used by `TasksView.tsx` (will be removed in ticket 3).

## Files to touch
- `src/components/TasksList.tsx` — rewrite to use `useTaskStore`, remove `cleanAgentTitle`, update navigation
