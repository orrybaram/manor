---
title: Wire TasksList into sidebar and remove debug panel
status: done
priority: high
assignee: sonnet
blocked_by: [1]
---

# Wire TasksList into sidebar and remove debug panel

## Wire TasksList into Sidebar

In `src/components/Sidebar.tsx`:
1. Import `TasksList` from `./TasksList`
2. Add `<TasksList />` between the closing `</div>` of the content area and `<PortsList />` (above ports, below the scrollable project list)

The sidebar layout becomes:
```
titlebar
content (scrollable: projects)
<TasksList />     ← new
<PortsList />
resize handle
```

## Remove AgentDebugPanel

In `src/App.tsx`:
1. Remove the import of `AgentDebugPanel`
2. Remove `<AgentDebugPanel />` from the JSX

Delete the files:
- `src/components/AgentDebugPanel.tsx`
- `src/components/AgentDebugPanel.module.css`

## Remove per-workspace WorkspaceAgentList

In `src/components/ProjectItem.tsx`:
1. Remove the `<WorkspaceAgentList>` component usage from the workspace mapping (lines ~284-292)
2. Remove the `WorkspaceAgentList` function component definition (lines ~392-438)
3. Remove unused imports: `useWorkspaceAgents`, `type WorkspaceAgent` (if no longer needed)
4. Remove `aggregateStatus` function if no longer used here
5. Keep `cleanAgentTitle`, `AgentItemLabel`, `STATUS_LABEL` only if they're imported by `TasksList.tsx` — otherwise remove them too

Note: If ticket 1 imported these helpers from `ProjectItem.tsx`, keep them exported. If ticket 1 defined its own copies, remove them from `ProjectItem.tsx`.

Also remove `src/hooks/useWorkspaceAgents.ts` if it's no longer imported anywhere after these changes. Check with grep first.

## Files to touch
- `src/components/Sidebar.tsx` — add `<TasksList />`
- `src/App.tsx` — remove `AgentDebugPanel`
- `src/components/AgentDebugPanel.tsx` — delete
- `src/components/AgentDebugPanel.module.css` — delete
- `src/components/ProjectItem.tsx` — remove `WorkspaceAgentList` and related code
- `src/hooks/useWorkspaceAgents.ts` — possibly delete if unused
