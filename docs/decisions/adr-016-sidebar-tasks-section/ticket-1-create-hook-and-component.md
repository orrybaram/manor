---
title: Create useAllAgents hook and TasksList component
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Create useAllAgents hook and TasksList component

## useAllAgents hook

Create `src/hooks/useAllAgents.ts`. This hook collects all non-idle agents across ALL projects/workspaces.

**Interface:**
```typescript
export interface GlobalAgent {
  paneId: string;
  sessionId: string;
  agent: AgentState;
  projectName: string;
  projectIndex: number;
  workspaceIndex: number;
  workspacePath: string;
}
```

**Logic:**
1. Subscribe to `useProjectStore` for `projects` array
2. Subscribe to `useAppStore` for `paneAgentStatus` and `workspaceSessions`
3. For each project → for each workspace → look up `workspaceSessions[ws.path]` → for each session → `allPaneIds(session.rootNode)` → check `paneAgentStatus[paneId]`
4. Filter out idle agents (`status !== "idle"`)
5. Return `GlobalAgent[]` grouped by project (or flat with project info attached)
6. Use referential stability pattern (compare with prev ref) like `useWorkspaceAgents`

## TasksList component

Create `src/components/TasksList.tsx`, modeled after `PortsList.tsx`:

1. Collapsible section with "Tasks" header, count badge, and chevron
2. Uses `useAllAgents()` hook
3. If no active agents, return null (hide section entirely)
4. Group agents by `projectName`
5. Each project group has a clickable header showing project name
6. Each agent item shows: `AgentDot` + cleaned title (via `cleanAgentTitle`) + `AgentItemLabel` for status
7. Clicking an agent item calls `onNavigate` which:
   - `selectProject(agent.projectIndex)`
   - `setProjectExpanded(projectId)`
   - `selectWorkspace(projectId, agent.workspaceIndex)`
   - `setActiveWorkspace(agent.workspacePath)`
   - `useAppStore.getState().selectSession(agent.sessionId)`
   - `useAppStore.getState().focusPane(agent.paneId)`

**Reuse from ProjectItem.tsx** — move these to a shared location or import them:
- `cleanAgentTitle` function
- `AgentItemLabel` component
- `STATUS_LABEL` constant
- `aggregateStatus` function

Since `ProjectItem.tsx` will have the per-workspace agent list removed (ticket 2), these helpers can stay in `ProjectItem.tsx` and be exported, OR moved to a utils file. Simplest: just define them directly in `TasksList.tsx` or in a small shared file.

## CSS

Add styles to `Sidebar.module.css`:

```css
.tasksSection {
  flex-shrink: 0;
  border-top: 1px solid var(--surface);
  padding: 4px 8px;
}

.taskGroups {
  max-height: 200px;
  overflow-y: auto;
  padding: 0 6px;
}

.taskGroup {
  display: flex;
  flex-direction: column;
  gap: 1px;
  margin-bottom: 4px;
}

.taskGroupHeader {
  padding: 2px 6px;
  font-size: 10px;
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

Reuse existing `.agentItem`, `.agentName`, `.agentStatusLabel`, and `AgentDot` styles.

## Files to touch
- `src/hooks/useAllAgents.ts` — new file, create the hook
- `src/components/TasksList.tsx` — new file, create the component
- `src/components/Sidebar.module.css` — add tasks section styles
